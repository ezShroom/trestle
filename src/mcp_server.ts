import 'colors'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import type { Request, Response } from 'express'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { defaultMcpHost, defaultMcpPath, packageCommand, packageVersion } from './constants'
import { loadConfig, loadState } from './fs_state'

function buildPlaceholderServer() {
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
				'This is the local computer-use MCP endpoint. Tooling is intentionally minimal while the transport and background service are being built out.'
		}
	)

	server.registerTool(
		'computer_status',
		{
			description: 'Return the current local daemon and tunnel status.',
			inputSchema: {}
		},
		async () => {
			const config = loadConfig()
			const state = loadState()
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								computerName: config?.computerName ?? null,
								health: state.health,
								statusMessage: state.statusMessage,
								tunnelUrl: state.tunnelUrl ?? null,
								connectionId: state.connectionId ?? null
							},
							null,
							2
						)
					}
				]
			}
		}
	)

	server.registerTool(
		'echo',
		{
			description: 'Placeholder tool used to confirm the local MCP server is alive.',
			inputSchema: {
				message: z.string().default('hello')
			}
		},
		async ({ message }) => {
			return {
				content: [
					{
						type: 'text',
						text: `echo: ${message}`
					}
				]
			}
		}
	)

	return server
}

async function startMcpServer(port: number) {
	const app = createMcpExpressApp({ host: defaultMcpHost })

	app.post(defaultMcpPath, async (req: Request, res: Response) => {
		const server = buildPlaceholderServer()

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
		close: () =>
			new Promise<void>((resolve, reject) => {
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

export { startMcpServer }
