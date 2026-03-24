import 'colors'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Request, Response } from 'express'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { AgentCliManager } from './agent_cli_runtime'
import { defaultMcpHost, defaultMcpPath, packageCommand, packageVersion } from './constants'
import { FileToolManager } from './file_runtime'
import { loadConfig, loadState } from './fs_state'
import { normalizeComputerName } from './runtime'
import { TerminalManager } from './terminal_runtime'
import { VisionManager } from './vision_runtime'

function jsonContent(value: unknown) {
	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify(value, null, 2)
			}
		]
	}
}

function buildMcpServer(
	terminalManager: TerminalManager,
	agentCliManager: AgentCliManager,
	fileToolManager: FileToolManager,
	visionManager: VisionManager
) {
	const config = loadConfig()
	const computerSlug = normalizeComputerName(config?.computerName ?? 'computer')
	const toolName = (suffix: string) => `${computerSlug}_${suffix}`
	const server = new McpServer(
		{
			name: packageCommand,
			version: packageVersion
		},
		{
			capabilities: {
				logging: {}
			},
			instructions:
				'This is the local computer-use MCP endpoint. It exposes persistent terminal sessions with blocking execution by default.'
		}
	)

	server.registerTool(
		toolName('computer_status'),
		{
			description: 'Return the current local daemon, tunnel, and terminal runtime status.',
			inputSchema: {}
		},
		async () => {
			const state = loadState()
			return jsonContent({
				computerName: config?.computerName ?? null,
				computerSlug,
				health: state.health,
				statusMessage: state.statusMessage,
				tunnelUrl: state.tunnelUrl ?? null,
				connectionId: state.connectionId ?? null,
				terminal: terminalManager.summary(),
				agentCli: agentCliManager.summary(),
				fileTools: fileToolManager.summary(),
				vision: {
					enabled: true
				}
			})
		}
	)

	server.registerTool(
		toolName('agent_cli_status'),
		{
			description:
				'Check whether Claude Code, Codex, and OpenCode CLIs are installed and authenticated, plus recommended model-category mappings.',
			inputSchema: {}
		},
		async () => jsonContent(await agentCliManager.getStatus())
	)

	server.registerTool(
		toolName('agent_cli_read_run'),
		{
			description: 'Read stdout or stderr from a prior Claude Code, Codex, or OpenCode run by byte cursor.',
			inputSchema: {
				runId: z.string(),
				stream: z.enum(['stdout', 'stderr']).optional(),
				cursor: z.number().int().nonnegative().optional(),
				limitBytes: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(agentCliManager.readRun(input))
	)

	server.registerTool(
		toolName('claude_code'),
		{
			description:
				'Run Claude Code in blocking print mode with structured JSON output. Returns a resumable session id, summary, logs, and parsed result.',
			inputSchema: {
				prompt: z.string(),
				cwd: z.string().optional(),
				sessionId: z.string().optional(),
				continueMostRecent: z.boolean().optional(),
				forkSession: z.boolean().optional(),
				model: z.string().optional(),
				modelCategory: z.enum(['opus', 'sonnet', 'haiku']).optional(),
				permissionMode: z
					.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'])
					.optional(),
				addDirs: z.array(z.string()).optional(),
				appendSystemPrompt: z.string().optional(),
				systemPrompt: z.string().optional(),
				mcpConfig: z.array(z.string()).optional(),
				allowedTools: z.array(z.string()).optional(),
				disallowedTools: z.array(z.string()).optional(),
				maxBudgetUsd: z.number().positive().optional(),
				timeoutMs: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(await agentCliManager.runClaudeCode(input))
	)

	server.registerTool(
		toolName('codex'),
		{
			description:
				'Run Codex CLI in blocking exec mode with JSONL output. Returns a resumable thread id, summary, logs, and parsed events.',
			inputSchema: {
				prompt: z.string(),
				cwd: z.string().optional(),
				sessionId: z.string().optional(),
				resumeMostRecent: z.boolean().optional(),
				model: z.string().optional(),
				modelCategory: z.enum(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']).optional(),
				reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
				sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
				fullAuto: z.boolean().optional(),
				dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
				skipGitRepoCheck: z.boolean().optional(),
				addDirs: z.array(z.string()).optional(),
				outputSchema: z.string().optional(),
				configOverrides: z.array(z.string()).optional(),
				timeoutMs: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(await agentCliManager.runCodex(input))
	)

	server.registerTool(
		toolName('opencode'),
		{
			description:
				'Run OpenCode in blocking JSON event mode. Returns a resumable session id when available, summary, logs, and parsed events.',
			inputSchema: {
				prompt: z.string(),
				cwd: z.string().optional(),
				sessionId: z.string().optional(),
				continueMostRecent: z.boolean().optional(),
				forkSession: z.boolean().optional(),
				model: z.string().optional(),
				modelCategory: z
					.enum([
						'anthropic_opus',
						'anthropic_sonnet',
						'anthropic_haiku',
						'openai_gpt_5_4',
						'openai_gpt_5_4_mini',
						'openai_gpt_5_3_codex'
					])
					.optional(),
				agent: z.string().optional(),
				reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
				variant: z.string().optional(),
				files: z.array(z.string()).optional(),
				share: z.boolean().optional(),
				title: z.string().optional(),
				timeoutMs: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(await agentCliManager.runOpenCode(input))
	)

	server.registerTool(
		toolName('read_image'),
		{
			description: 'Read a local image file and return it as MCP image content.',
			inputSchema: {
				path: z.string()
			}
		},
		async (input) => visionManager.readImage(input)
	)

	server.registerTool(
		toolName('screenshot'),
		{
			description: 'Capture the current display contents and return one image per captured display when supported by the OS.',
			inputSchema: {
				display: z.number().int().positive().optional()
			}
		},
		async (input) => visionManager.screenshot(input)
	)

	server.registerTool(
		toolName('read'),
		{
			description: 'Read a text file with numbered lines and return a snapshot id for later edits.',
			inputSchema: {
				path: z.string(),
				offset: z.number().int().positive().optional(),
				limit: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(fileToolManager.read(input))
	)

	server.registerTool(
		toolName('write'),
		{
			description: 'Create or replace a UTF-8 text file.',
			inputSchema: {
				path: z.string(),
				content: z.string()
			}
		},
		async (input) => jsonContent(fileToolManager.write(input))
	)

	server.registerTool(
		toolName('edit'),
		{
			description: 'Apply one exact text replacement to a file using a prior snapshot id.',
			inputSchema: {
				path: z.string(),
				snapshotId: z.string(),
				oldString: z.string(),
				newString: z.string(),
				replaceAll: z.boolean().optional()
			}
		},
		async (input) => jsonContent(fileToolManager.edit(input))
	)

	server.registerTool(
		toolName('multiedit'),
		{
			description: 'Apply multiple exact text replacements atomically using a prior snapshot id.',
			inputSchema: {
				path: z.string(),
				snapshotId: z.string(),
				edits: z.array(
					z.object({
						oldString: z.string(),
						newString: z.string(),
						replaceAll: z.boolean().optional()
					})
				)
			}
		},
		async (input) => jsonContent(fileToolManager.multiEdit(input))
	)

	server.registerTool(
		toolName('ls'),
		{
			description: 'List a directory directly from the filesystem.',
			inputSchema: {
				path: z.string(),
				recursive: z.boolean().optional(),
				limit: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(fileToolManager.list(input))
	)

	server.registerTool(
		toolName('glob'),
		{
			description: 'Find filesystem paths using a glob pattern.',
			inputSchema: {
				pattern: z.string(),
				root: z.string().optional(),
				limit: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(fileToolManager.glob(input))
	)

	server.registerTool(
		toolName('grep'),
		{
			description: 'Search file contents recursively without using the terminal.',
			inputSchema: {
				pattern: z.string(),
				root: z.string().optional(),
				include: z.array(z.string()).optional(),
				exclude: z.array(z.string()).optional(),
				limit: z.number().int().positive().optional(),
				regex: z.boolean().optional(),
				caseSensitive: z.boolean().optional()
			}
		},
		async (input) => jsonContent(fileToolManager.grep(input))
	)

	server.registerTool(
		toolName('terminal_session_create'),
		{
			description: 'Create a persistent terminal session.',
			inputSchema: {
				cwd: z.string().optional(),
				env: z.record(z.string(), z.string()).optional(),
				shell: z.string().optional(),
				label: z.string().optional()
			}
		},
		async (input) => jsonContent(await terminalManager.createSession(input))
	)

	server.registerTool(
		toolName('terminal_exec'),
		{
			description: 'Execute one command or a small sequential batch inside a persistent terminal session.',
			inputSchema: {
				sessionId: z.string(),
				command: z.string().optional(),
				commands: z.array(z.string()).optional(),
				wait: z.boolean().default(true),
				timeoutMs: z.number().int().positive().optional(),
				maxOutputBytes: z.number().int().positive().optional(),
				label: z.string().optional()
			}
		},
		async (input) => jsonContent(await terminalManager.exec(input))
	)

	server.registerTool(
		toolName('terminal_read'),
		{
			description: 'Read terminal output from a prior command using a byte cursor.',
			inputSchema: {
				sessionId: z.string(),
				commandId: z.string().optional(),
				cursor: z.number().int().nonnegative().optional(),
				limitBytes: z.number().int().positive().optional()
			}
		},
		async (input) => jsonContent(terminalManager.read(input))
	)

	server.registerTool(
		toolName('terminal_search_output'),
		{
			description: 'Search retained terminal output for literal text or regex matches.',
			inputSchema: {
				sessionId: z.string(),
				commandId: z.string().optional(),
				query: z.string(),
				limit: z.number().int().positive().optional(),
				regex: z.boolean().default(false),
				before: z.number().int().nonnegative().optional(),
				after: z.number().int().nonnegative().optional()
			}
		},
		async (input) => jsonContent(terminalManager.search(input))
	)

	server.registerTool(
		toolName('terminal_status'),
		{
			description: 'Inspect the current state of a terminal session and its active command, if any.',
			inputSchema: {
				sessionId: z.string()
			}
		},
		async ({ sessionId }) => jsonContent(terminalManager.status(sessionId))
	)

	server.registerTool(
		toolName('terminal_interrupt'),
		{
			description: 'Interrupt the active command in a terminal session.',
			inputSchema: {
				sessionId: z.string(),
				commandId: z.string().optional()
			}
		},
		async (input) => jsonContent(await terminalManager.interrupt(input))
	)

	server.registerTool(
		toolName('terminal_session_close'),
		{
			description: 'Close a terminal session and terminate any remaining child processes.',
			inputSchema: {
				sessionId: z.string()
			}
		},
		async ({ sessionId }) => jsonContent(await terminalManager.closeSession(sessionId))
	)

	return server
}

async function startMcpServer(
	port: number,
	terminalManager: TerminalManager,
	agentCliManager: AgentCliManager,
	fileToolManager: FileToolManager,
	visionManager: VisionManager
) {
	const app = createMcpExpressApp({ host: defaultMcpHost })

	app.post(defaultMcpPath, async (req: Request, res: Response) => {
		const server = buildMcpServer(terminalManager, agentCliManager, fileToolManager, visionManager)

		try {
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined
			})
			await server.connect(transport)
			await transport.handleRequest(req, res, req.body)
			res.on('close', () => {
				void transport.close()
				void server.close()
			})
		} catch (error) {
			console.error(`MCP request failed: ${String(error)}`.red)
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: '2.0',
					error: {
						code: -32603,
						message: 'Internal server error'
					},
					id: null
				})
			}
		}
	})

	app.get(defaultMcpPath, (_req: Request, res: Response) => {
		res.status(405).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Method not allowed.'
			},
			id: null
		})
	})

	app.delete(defaultMcpPath, (_req: Request, res: Response) => {
		res.status(405).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Method not allowed.'
			},
			id: null
		})
	})

	const httpServer = await new Promise<HttpServer>((resolve, reject) => {
		const server = app.listen(port, defaultMcpHost, () => {
			server.off('error', reject)
			resolve(server)
		})
		server.once('error', reject)
	})

	const address = httpServer.address() as AddressInfo | null
	const actualPort = address?.port ?? port

	console.log(
		`${packageCommand} MCP server listening on http://${defaultMcpHost}:${String(actualPort)}${defaultMcpPath}`.green
	)

	return {
		port: actualPort,
		close: async () => {
			await fileToolManager.shutdown().catch(() => {})
			await terminalManager.shutdown().catch(() => {})
			return new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
		}
	}
}

export { startMcpServer }
