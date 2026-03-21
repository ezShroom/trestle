import 'colors'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Request, Response } from 'express'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { defaultMcpHost, defaultMcpPath, packageCommand, packageVersion } from './constants'
import { loadConfig, loadState } from './fs_state'
import { normalizeComputerName } from './runtime'
import { TerminalManager } from './terminal_runtime'

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

function buildMcpServer(terminalManager: TerminalManager) {
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
				terminal: terminalManager.summary()
			})
		}
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

async function startMcpServer(port: number, terminalManager: TerminalManager) {
	const app = createMcpExpressApp({ host: defaultMcpHost })

	app.post(defaultMcpPath, async (req: Request, res: Response) => {
		const server = buildMcpServer(terminalManager)

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
