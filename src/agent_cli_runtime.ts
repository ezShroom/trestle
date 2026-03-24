import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { defaultAgentCliReadBytes, maxAgentCliReadBytes, maxAgentCliRetentionBytes } from './constants'
import { ensureAppDirs } from './fs_state'
import { agentCliLogDir } from './paths'

type AgentCliKind = 'claude_code' | 'codex' | 'opencode'
type AgentCliRunStatus = 'running' | 'success' | 'needs_input' | 'failed' | 'timed_out'
type ClaudeModelCategory = 'opus' | 'sonnet' | 'haiku'
type CodexModelCategory = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex'
type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type OpenCodeModelCategory =
	| 'anthropic_opus'
	| 'anthropic_sonnet'
	| 'anthropic_haiku'
	| 'openai_gpt_5_4'
	| 'openai_gpt_5_4_mini'
	| 'openai_gpt_5_3_codex'

interface AgentCliRunRecord {
	id: string
	kind: AgentCliKind
	command: string[]
	cwd: string
	createdAt: string
	startedAt: string
	endedAt?: string
	status: AgentCliRunStatus
	exitCode?: number | null
	timedOut: boolean
	runDir: string
	stdoutFile: string
	stderrFile: string
	stdoutBytes: number
	stderrBytes: number
	stdoutTail: string
	stderrTail: string
	sessionId?: string | null
	model?: string | null
	modelCategory?: string | null
	summary?: string | null
	usage?: unknown
	result?: unknown
	raw?: unknown
}

interface AgentCliReadInput {
	runId: string
	stream?: 'stdout' | 'stderr'
	cursor?: number
	limitBytes?: number
}

interface ClaudeCodeRunInput {
	prompt: string
	cwd?: string
	sessionId?: string
	continueMostRecent?: boolean
	forkSession?: boolean
	model?: string
	modelCategory?: ClaudeModelCategory
	permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'
	addDirs?: string[]
	appendSystemPrompt?: string
	systemPrompt?: string
	mcpConfig?: string[]
	allowedTools?: string[]
	disallowedTools?: string[]
	maxBudgetUsd?: number
	timeoutMs?: number
}

interface CodexRunInput {
	prompt: string
	cwd?: string
	sessionId?: string
	resumeMostRecent?: boolean
	model?: string
	modelCategory?: CodexModelCategory
	reasoningEffort?: ReasoningEffort
	sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
	fullAuto?: boolean
	dangerouslyBypassApprovalsAndSandbox?: boolean
	skipGitRepoCheck?: boolean
	addDirs?: string[]
	outputSchema?: string
	configOverrides?: string[]
	timeoutMs?: number
}

interface OpenCodeRunInput {
	prompt: string
	cwd?: string
	sessionId?: string
	continueMostRecent?: boolean
	forkSession?: boolean
	model?: string
	modelCategory?: OpenCodeModelCategory
	agent?: string
	reasoningEffort?: ReasoningEffort
	variant?: string
	files?: string[]
	share?: boolean
	title?: string
	timeoutMs?: number
}

interface CompletedProcessResult {
	exitCode: number | null
	timedOut: boolean
	stdoutText: string
	stderrText: string
	stdoutBytes: number
	stderrBytes: number
}

interface ParsedRunResult {
	sessionId: string | null
	usage: unknown
	result: unknown
	summary: string | null
	status: AgentCliRunStatus
}

function nowIso() {
	return new Date().toISOString()
}

function normalizeReadLimit(limitBytes?: number) {
	if (!limitBytes || Number.isNaN(limitBytes)) return defaultAgentCliReadBytes
	return Math.max(1, Math.min(limitBytes, maxAgentCliReadBytes))
}

function trimTail(value: string) {
	const buffer = Buffer.from(value, 'utf8')
	if (buffer.length <= maxAgentCliRetentionBytes) return buffer.toString('utf8')
	return buffer.subarray(buffer.length - maxAgentCliRetentionBytes).toString('utf8')
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

function looksLikeNeedsInput(value: string) {
	const text = value.trim()
	if (!text) return false
	return (
		text.endsWith('?') ||
		/\b(need|needs|awaiting|waiting for|require|requires)\b[\s\S]{0,80}\b(input|answer|clarification|confirmation|choice|decision)\b/i.test(
			text
		) ||
		/\b(which|what|where|when|who)\b[\s\S]{0,120}\?/i.test(text) ||
		/\bplease\b[\s\S]{0,120}\b(confirm|clarify|choose|answer|provide)\b/i.test(text)
	)
}

function safeParseJson(value: string) {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return null
	}
}

function resolveClaudeModel(model?: string, modelCategory?: ClaudeModelCategory) {
	if (model) return model
	switch (modelCategory) {
		case 'opus':
			return 'opus'
		case 'sonnet':
			return 'sonnet'
		case 'haiku':
			return 'haiku'
		default:
			return undefined
	}
}

function resolveCodexModel(model?: string, modelCategory?: CodexModelCategory) {
	if (model) return model
	switch (modelCategory) {
		case 'gpt-5.4-mini':
			return 'gpt-5.4-mini'
		case 'gpt-5.3-codex':
			return 'gpt-5.3-codex'
		case 'gpt-5.4':
		default:
			return 'gpt-5.4'
	}
}

function resolveOpenCodeModel(model?: string, modelCategory?: OpenCodeModelCategory) {
	if (model) return model
	switch (modelCategory) {
		case 'anthropic_opus':
			return 'anthropic/claude-opus-4-0'
		case 'anthropic_haiku':
			return 'anthropic/claude-3-5-haiku-latest'
		case 'openai_gpt_5_4':
			return 'openai/gpt-5.4'
		case 'openai_gpt_5_4_mini':
			return 'openai/gpt-5.4-mini'
		case 'openai_gpt_5_3_codex':
			return 'openai/gpt-5.3-codex'
		case 'anthropic_sonnet':
		default:
			return 'anthropic/claude-sonnet-4-0'
	}
}

function modelGuidance() {
	return {
		claudeCode: {
			recommendedCategory: 'opus',
			note: 'Prefer Claude aliases by family name instead of snapshot ids unless you need pinning.',
			categories: {
				opus: { model: 'opus', reason: 'Latest Claude Opus family for hardest work.' },
				sonnet: { model: 'sonnet', reason: 'Balanced Claude choice.' },
				haiku: { model: 'haiku', reason: 'Fastest Claude family.' }
			}
		},
		codex: {
			recommendedCategory: 'gpt-5.4',
			note: 'Keep the Codex defaults tight: GPT-5.4, GPT-5.4 Mini, and optional GPT-5.3 Codex. Reasoning effort is adjustable separately.',
			categories: {
				'gpt-5.4': { model: 'gpt-5.4', reason: 'Primary OpenAI default for hard coding work.' },
				'gpt-5.4-mini': { model: 'gpt-5.4-mini', reason: 'Lower-cost, lower-latency alternative.' },
				'gpt-5.3-codex': { model: 'gpt-5.3-codex', reason: 'Legacy Codex-flavoured option some people still prefer.' }
			}
		},
		opencode: {
			recommendedCategories: ['anthropic_opus', 'openai_gpt_5_4'],
			note: 'OpenCode needs provider/model ids, so these categories resolve to current provider-specific defaults and can still depend on which providers are configured locally.',
			categories: {
				anthropic_opus: { model: 'anthropic/claude-opus-4-0', reason: 'Best Anthropic family exposed via aliases.' },
				anthropic_sonnet: { model: 'anthropic/claude-sonnet-4-0', reason: 'Balanced Anthropic family.' },
				anthropic_haiku: { model: 'anthropic/claude-3-5-haiku-latest', reason: 'Fast Anthropic option.' },
				openai_gpt_5_4: { model: 'openai/gpt-5.4', reason: 'Primary OpenAI default.' },
				openai_gpt_5_4_mini: { model: 'openai/gpt-5.4-mini', reason: 'Lower-cost, lower-latency alternative.' },
				openai_gpt_5_3_codex: { model: 'openai/gpt-5.3-codex', reason: 'Legacy Codex-flavoured option.' }
			}
		}
	}
}

class AgentCliManager {
	private readonly runs = new Map<string, AgentCliRunRecord>()

	constructor() {
		ensureAppDirs()
	}

	summary() {
		let running = 0
		for (const run of this.runs.values()) {
			if (run.status === 'running') running += 1
		}

		return {
			runCount: this.runs.size,
			running
		}
	}

	readRun(input: AgentCliReadInput) {
		const run = this.requireRun(input.runId)
		const stream = input.stream ?? 'stdout'
		const filePath = stream === 'stderr' ? run.stderrFile : run.stdoutFile
		const payload = readBufferSlice(filePath, input.cursor ?? 0, normalizeReadLimit(input.limitBytes))
		return {
			runId: run.id,
			kind: run.kind,
			stream,
			status: run.status,
			cursor: payload.nextCursor,
			totalBytes: payload.totalBytes,
			returnedBytes: payload.returnedBytes,
			text: payload.text,
			truncated: payload.nextCursor < payload.totalBytes
		}
	}

	async runClaudeCode(input: ClaudeCodeRunInput) {
		const args = ['-p', '--output-format', 'json']
		const permissionMode = input.permissionMode ?? 'bypassPermissions'
		const resolvedModel = resolveClaudeModel(input.model, input.modelCategory)

		if (input.sessionId) args.push('-r', input.sessionId)
		else if (input.continueMostRecent) args.push('-c')

		if (input.forkSession) args.push('--fork-session')
		if (resolvedModel) args.push('--model', resolvedModel)
		if (permissionMode) {
			args.push('--permission-mode', permissionMode)
			if (permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
		}
		for (const addDir of input.addDirs ?? []) args.push('--add-dir', addDir)
		if (input.appendSystemPrompt) args.push('--append-system-prompt', input.appendSystemPrompt)
		if (input.systemPrompt) args.push('--system-prompt', input.systemPrompt)
		for (const entry of input.mcpConfig ?? []) args.push('--mcp-config', entry)
		if ((input.allowedTools?.length ?? 0) > 0) args.push('--allowedTools', ...(input.allowedTools ?? []))
		if ((input.disallowedTools?.length ?? 0) > 0) args.push('--disallowedTools', ...(input.disallowedTools ?? []))
		if (typeof input.maxBudgetUsd === 'number') args.push('--max-budget-usd', String(input.maxBudgetUsd))
		args.push(input.prompt)

		const run = this.createRunRecord('claude_code', 'claude', args, input.cwd, resolvedModel, input.modelCategory)
		const completed = await this.runProcess(run, 'claude', args, input.cwd, input.timeoutMs)
		const parsed = this.parseClaudeOutput(completed.stdoutText, completed.stderrText, completed.exitCode, completed.timedOut)

		return this.finishRun(run, completed, parsed)
	}

	async runCodex(input: CodexRunInput) {
		const args = ['exec', '--json']
		const resolvedModel = resolveCodexModel(input.model, input.modelCategory)
		const bypassApprovalsAndSandbox = input.dangerouslyBypassApprovalsAndSandbox ?? true

		if (input.sessionId || input.resumeMostRecent) {
			args.push('resume')
			if (input.resumeMostRecent) args.push('--last')
			else if (input.sessionId) args.push(input.sessionId)
		}

		if (resolvedModel) args.push('--model', resolvedModel)
		if (input.reasoningEffort) args.push('--config', `reasoning_effort="${input.reasoningEffort}"`)
		if (input.sandbox) args.push('--sandbox', input.sandbox)
		if (input.fullAuto) args.push('--full-auto')
		if (bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox')
		if (input.skipGitRepoCheck) args.push('--skip-git-repo-check')
		for (const addDir of input.addDirs ?? []) args.push('--add-dir', addDir)
		if (input.outputSchema) args.push('--output-schema', input.outputSchema)
		for (const override of input.configOverrides ?? []) args.push('--config', override)
		args.push(input.prompt)

		const run = this.createRunRecord('codex', 'codex', args, input.cwd, resolvedModel, input.modelCategory)
		const completed = await this.runProcess(run, 'codex', args, input.cwd, input.timeoutMs)
		const parsed = this.parseCodexOutput(completed.stdoutText, completed.stderrText, completed.exitCode, completed.timedOut)

		return this.finishRun(run, completed, parsed)
	}

	async runOpenCode(input: OpenCodeRunInput) {
		const args = ['run', '--format', 'json']
		const resolvedModel = resolveOpenCodeModel(input.model, input.modelCategory)

		if (input.continueMostRecent) args.push('--continue')
		if (input.sessionId) args.push('--session', input.sessionId)
		if (input.forkSession) args.push('--fork')
		if (resolvedModel) args.push('--model', resolvedModel)
		if (input.agent) args.push('--agent', input.agent)
		if (input.variant) args.push('--variant', input.variant)
		else if (input.reasoningEffort) args.push('--variant', input.reasoningEffort)
		if (input.share) args.push('--share')
		if (input.title) args.push('--title', input.title)
		if (input.cwd) args.push('--dir', path.resolve(input.cwd))
		for (const filePath of input.files ?? []) args.push('--file', filePath)
		args.push(input.prompt)

		const run = this.createRunRecord('opencode', 'opencode', args, input.cwd, resolvedModel, input.modelCategory)
		const completed = await this.runProcess(run, 'opencode', args, input.cwd, input.timeoutMs)
		const parsed = this.parseOpenCodeOutput(completed.stdoutText, completed.stderrText, completed.exitCode, completed.timedOut)

		return this.finishRun(run, completed, parsed)
	}

	async getStatus() {
		const [claude, codex, opencode, claudeVersion, codexVersion, opencodeVersion] = await Promise.all([
			this.runUtilityCommand('claude', ['auth', 'status', '--text']),
			this.runUtilityCommand('codex', ['login', 'status']),
			this.runUtilityCommand('opencode', ['providers', 'list']),
			this.getVersion('claude'),
			this.getVersion('codex'),
			this.getVersion('opencode')
		])

		return {
			modelGuidance: modelGuidance(),
			claudeCode: {
				installed: claude.spawned,
				version: claudeVersion,
				authenticated: claude.exitCode === 0,
				statusText: claude.stdout.trim() || claude.stderr.trim() || null
			},
			codex: {
				installed: codex.spawned,
				version: codexVersion,
				authenticated: codex.exitCode === 0,
				statusText: codex.stdout.trim() || codex.stderr.trim() || null
			},
			opencode: {
				installed: opencode.spawned,
				version: opencodeVersion,
				authenticated: opencode.exitCode === 0,
				statusText: opencode.stdout.trim() || opencode.stderr.trim() || null
			}
		}
	}

	private createRunRecord(
		kind: AgentCliKind,
		binary: string,
		args: string[],
		cwd?: string,
		model?: string,
		modelCategory?: string
	) {
		const id = randomUUID()
		const runDir = path.join(agentCliLogDir, id)
		fs.mkdirSync(runDir, { recursive: true })

		const run: AgentCliRunRecord = {
			id,
			kind,
			command: [binary, ...args],
			cwd: path.resolve(cwd ?? process.cwd()),
			createdAt: nowIso(),
			startedAt: nowIso(),
			status: 'running',
			timedOut: false,
			runDir,
			stdoutFile: path.join(runDir, 'stdout.log'),
			stderrFile: path.join(runDir, 'stderr.log'),
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutTail: '',
			stderrTail: '',
			model: model ?? null,
			modelCategory: modelCategory ?? null
		}

		fs.writeFileSync(run.stdoutFile, '')
		fs.writeFileSync(run.stderrFile, '')
		this.runs.set(id, run)
		return run
	}

	private async runProcess(
		run: AgentCliRunRecord,
		binary: string,
		args: string[],
		cwd: string | undefined,
		timeoutMs?: number
	): Promise<CompletedProcessResult> {
		return await new Promise<CompletedProcessResult>((resolve, reject) => {
			const child = spawn(binary, args, {
				cwd: path.resolve(cwd ?? process.cwd()),
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe']
			})

			let stdoutBytes = 0
			let stderrBytes = 0
			let stdoutTail = ''
			let stderrTail = ''
			let timedOut = false
			let settled = false

			const timer =
				typeof timeoutMs === 'number' && timeoutMs > 0
					? setTimeout(() => {
							timedOut = true
							run.timedOut = true
							run.status = 'timed_out'
							try {
								child.kill('SIGTERM')
							} catch {}
						}, timeoutMs)
					: null

			timer?.unref()

			child.stdout.on('data', (chunk: Buffer | string) => {
				const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
				fs.appendFileSync(run.stdoutFile, text)
				stdoutBytes += Buffer.byteLength(text)
				stdoutTail = trimTail(`${stdoutTail}${text}`)
			})

			child.stderr.on('data', (chunk: Buffer | string) => {
				const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
				fs.appendFileSync(run.stderrFile, text)
				stderrBytes += Buffer.byteLength(text)
				stderrTail = trimTail(`${stderrTail}${text}`)
			})

			child.on('error', (error) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				reject(error)
			})

			child.on('close', (exitCode) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				run.stdoutBytes = stdoutBytes
				run.stderrBytes = stderrBytes
				run.stdoutTail = stdoutTail
				run.stderrTail = stderrTail
				resolve({
					exitCode,
					timedOut,
					stdoutText: fs.readFileSync(run.stdoutFile, 'utf8'),
					stderrText: fs.readFileSync(run.stderrFile, 'utf8'),
					stdoutBytes,
					stderrBytes
				})
			})
		})
	}

	private parseClaudeOutput(stdout: string, stderr: string, exitCode: number | null, timedOut: boolean): ParsedRunResult {
		const parsed = safeParseJson(stdout.trim())
		const resultText =
			parsed && typeof parsed === 'object' && 'result' in parsed && typeof parsed.result === 'string' ? parsed.result : stdout.trim()
		const sessionId =
			parsed && typeof parsed === 'object' && 'session_id' in parsed && typeof parsed.session_id === 'string'
				? parsed.session_id
				: null
		const usage = parsed && typeof parsed === 'object' && 'usage' in parsed ? parsed.usage : null
		const isError =
			timedOut ||
			exitCode !== 0 ||
			(parsed && typeof parsed === 'object' && 'is_error' in parsed && Boolean(parsed.is_error))
		const summary = resultText || stderr.trim() || (isError ? 'Claude Code run failed.' : null)

		return {
			sessionId,
			usage,
			result: parsed,
			summary,
			status: isError ? 'failed' : looksLikeNeedsInput(resultText) ? 'needs_input' : 'success'
		}
	}

	private parseCodexOutput(stdout: string, stderr: string, exitCode: number | null, timedOut: boolean): ParsedRunResult {
		const lines = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
		const events = lines.map((line) => safeParseJson(line)).filter((event) => event !== null)
		let sessionId: string | null = null
		let usage: unknown = null
		let lastAgentMessage = ''
		let errorMessage = ''
		const commandExecutions: Array<{ command: string; exitCode: number | null; output: string }> = []

		for (const event of events) {
			if (!event || typeof event !== 'object') continue
			if ('type' in event && event.type === 'thread.started' && 'thread_id' in event && typeof event.thread_id === 'string') {
				sessionId = event.thread_id
			}
			if ('type' in event && event.type === 'turn.completed' && 'usage' in event) {
				usage = event.usage
			}
			if ('type' in event && event.type === 'error' && 'message' in event && typeof event.message === 'string') {
				errorMessage = event.message
			}
			if ('type' in event && event.type === 'turn.failed' && 'error' in event && event.error && typeof event.error === 'object') {
				if ('message' in event.error && typeof event.error.message === 'string') errorMessage = event.error.message
			}
			if ('type' in event && event.type === 'item.completed' && 'item' in event && event.item && typeof event.item === 'object') {
				if ('type' in event.item && event.item.type === 'agent_message' && 'text' in event.item && typeof event.item.text === 'string') {
					lastAgentMessage = event.item.text
				}
				if ('type' in event.item && event.item.type === 'command_execution' && 'command' in event.item) {
					commandExecutions.push({
						command: typeof event.item.command === 'string' ? event.item.command : '',
						exitCode: 'exit_code' in event.item && typeof event.item.exit_code === 'number' ? event.item.exit_code : null,
						output: 'aggregated_output' in event.item && typeof event.item.aggregated_output === 'string' ? event.item.aggregated_output : ''
					})
				}
			}
		}

		const isError = timedOut || exitCode !== 0
		const summary = lastAgentMessage || errorMessage || stderr.trim() || (isError ? 'Codex run failed.' : null)

		return {
			sessionId,
			usage,
			result: {
				events,
				lastAgentMessage,
				commandExecutions
			},
			summary,
			status: isError ? 'failed' : looksLikeNeedsInput(lastAgentMessage) ? 'needs_input' : 'success'
		}
	}

	private parseOpenCodeOutput(stdout: string, stderr: string, exitCode: number | null, timedOut: boolean): ParsedRunResult {
		const lines = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
		const events = lines.map((line) => safeParseJson(line)).filter((event) => event !== null)
		let sessionId: string | null = null
		let usage: unknown = null
		let lastAssistantMessage = ''
		let errorMessage = ''

		for (const event of events) {
			if (!event || typeof event !== 'object') continue
			if ('sessionID' in event && typeof event.sessionID === 'string') sessionId = event.sessionID
			if ('sessionId' in event && typeof event.sessionId === 'string') sessionId = event.sessionId
			if ('usage' in event) usage = event.usage
			if ('text' in event && typeof event.text === 'string') lastAssistantMessage = event.text
			if ('message' in event && typeof event.message === 'string') lastAssistantMessage = event.message
			if ('error' in event && typeof event.error === 'string') errorMessage = event.error
			if ('content' in event && Array.isArray(event.content)) {
				const lastTextBlock = event.content
					.filter((entry) => entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string')
					.pop()
				if (lastTextBlock && typeof lastTextBlock === 'object' && 'text' in lastTextBlock && typeof lastTextBlock.text === 'string') {
					lastAssistantMessage = lastTextBlock.text
				}
			}
		}

		const combinedText = `${stdout}\n${stderr}`
		const inferredError = /Error:|ProviderModelNotFoundError|Failed to run|Unexpected error/i.test(combinedText)
		const isError = timedOut || exitCode !== 0 || inferredError
		const summary = errorMessage || lastAssistantMessage || stderr.trim() || stdout.trim() || (isError ? 'OpenCode run failed.' : null)

		return {
			sessionId,
			usage,
			result: {
				events
			},
			summary,
			status: isError ? 'failed' : looksLikeNeedsInput(lastAssistantMessage || stdout) ? 'needs_input' : 'success'
		}
	}

	private finishRun(run: AgentCliRunRecord, completed: CompletedProcessResult, parsed: ParsedRunResult) {
		run.endedAt = nowIso()
		run.exitCode = completed.exitCode
		run.timedOut = completed.timedOut
		run.sessionId = parsed.sessionId
		run.usage = parsed.usage
		run.result = parsed.result
		run.summary = parsed.summary
		run.status = completed.timedOut ? 'timed_out' : parsed.status
		run.raw = {
			stdoutTail: run.stdoutTail,
			stderrTail: run.stderrTail
		}

		return {
			runId: run.id,
			kind: run.kind,
			status: run.status,
			sessionId: run.sessionId ?? null,
			model: run.model ?? null,
			modelCategory: run.modelCategory ?? null,
			summary: run.summary ?? null,
			usage: run.usage ?? null,
			exitCode: run.exitCode ?? null,
			timedOut: run.timedOut,
			command: run.command,
			cwd: run.cwd,
			stdout: {
				path: run.stdoutFile,
				bytes: completed.stdoutBytes,
				tail: run.stdoutTail
			},
			stderr: {
				path: run.stderrFile,
				bytes: completed.stderrBytes,
				tail: run.stderrTail
			},
			result: run.result ?? null
		}
	}

	private requireRun(runId: string) {
		const run = this.runs.get(runId)
		if (!run) throw new Error(`Unknown agent CLI run: ${runId}`)
		return run
	}

	private async runUtilityCommand(binary: string, args: string[]) {
		try {
			const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string; spawned: boolean }>(
				(resolve) => {
					const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
					let stdout = ''
					let stderr = ''

					child.stdout.on('data', (chunk: Buffer | string) => {
						stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
					})
					child.stderr.on('data', (chunk: Buffer | string) => {
						stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
					})
					child.on('error', () => {
						resolve({ exitCode: null, stdout, stderr, spawned: false })
					})
					child.on('close', (exitCode) => {
						resolve({ exitCode, stdout, stderr, spawned: true })
					})
				}
			)
			return result
		} catch {
			return { exitCode: null, stdout: '', stderr: '', spawned: false }
		}
	}

	private async getVersion(binary: string) {
		const result = await this.runUtilityCommand(binary, ['--version'])
		return result.stdout.trim() || result.stderr.trim() || null
	}
}

export { AgentCliManager }
