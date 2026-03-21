import 'colors'
import { PokeTunnel } from 'poke'
import { checkPokeAuth } from './auth'
import { defaultMcpPort, packageCommand } from './constants'
import { FileToolManager } from './file_runtime'
import { ensureAppDirs, loadConfig, updateState } from './fs_state'
import { localMcpUrl } from './paths'
import { formatError, isPokeLoginMessage, normalizeComputerName, sleep } from './runtime'
import { startMcpServer } from './mcp_server'
import { TerminalManager } from './terminal_runtime'
import { maybeNotifyAboutUpdate } from './update_check'

export async function runDaemon() {
	ensureAppDirs()

	const config = loadConfig()
	if (!config) {
		throw new Error(`No config found. Run '${packageCommand} setup' first.`)
	}

	updateState((state) => ({
		...state,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		health: 'starting',
		statusMessage: 'Starting local MCP server...'
	}))

	const terminalManager = new TerminalManager()
	const fileToolManager = new FileToolManager()
	const mcpServer = await startMcpServer(config.port || defaultMcpPort, terminalManager, fileToolManager)
	void maybeNotifyAboutUpdate()

	let stopRequested = false
	const stop = () => {
		stopRequested = true
	}

	process.on('SIGINT', stop)
	process.on('SIGTERM', stop)

	try {
		while (!stopRequested) {
			const auth = await checkPokeAuth()
			updateState((state) => ({
				...state,
				lastAuthCheckAt: new Date().toISOString()
			}))

			if (!auth.ok) {
				if (auth.authRequired) {
					updateState((state) => ({
						...state,
						health: 'auth_required',
						statusMessage: "Poke auth is missing. Run 'poke login' and the daemon will recover.",
						lastError: auth.message,
						tunnelUrl: undefined,
						connectionId: undefined
					}))
					console.error(auth.message.yellow)
					await sleep(30_000)
					continue
				}

				updateState((state) => ({
					...state,
					health: 'network_wait',
					statusMessage: 'Poke auth check failed due to a non-auth error. Retrying.',
					lastError: auth.message,
					tunnelUrl: undefined,
					connectionId: undefined
				}))
				console.error(auth.message.red)
				await sleep(10_000)
				continue
			}

			const tunnel = new PokeTunnel({
				url: localMcpUrl(mcpServer.port),
				name: `${normalizeComputerName(config.computerName)}_queen-poke`,
				syncIntervalMs: 5 * 60 * 1_000
			})

			let terminalError: Error | null = null
			let terminalResolve: (() => void) | null = null
			const terminalPromise = new Promise<void>((resolve) => {
				terminalResolve = resolve
			})

			tunnel.on('connected', (info) => {
				updateState((state) => ({
					...state,
					health: 'running',
					statusMessage: `Tunnel connected as ${config.computerName}.`,
					tunnelUrl: info.tunnelUrl,
					connectionId: info.connectionId,
					lastError: undefined
				}))
			})

			tunnel.on('disconnected', () => {
				updateState((state) => ({
					...state,
					health: 'network_wait',
					statusMessage: 'Tunnel disconnected. PokeTunnel is attempting to reconnect.',
					lastError: undefined
				}))
			})

			tunnel.on('error', (error) => {
				terminalError = error
				terminalResolve?.()
			})

			updateState((state) => ({
				...state,
				lastTunnelAttemptAt: new Date().toISOString(),
				statusMessage: 'Connecting tunnel to Poke...'
			}))

			try {
				const info = await tunnel.start()
				updateState((state) => ({
					...state,
					health: 'running',
					statusMessage: `Tunnel connected as ${config.computerName}.`,
					tunnelUrl: info.tunnelUrl,
					connectionId: info.connectionId,
					lastError: undefined
				}))

				while (!stopRequested && !terminalError) {
					await Promise.race([terminalPromise, sleep(1_000)])
				}
			} catch (error) {
				terminalError = error instanceof Error ? error : new Error(String(error))
			} finally {
				await tunnel.stop().catch(() => {})
			}

			if (stopRequested) break

			const message = formatError(terminalError)
			if (isPokeLoginMessage(message)) {
				updateState((state) => ({
					...state,
					health: 'auth_required',
					statusMessage: "Tunnel failed because Poke auth is missing. Run 'poke login' and the daemon will retry.",
					lastError: message,
					tunnelUrl: undefined,
					connectionId: undefined
				}))
				await sleep(30_000)
				continue
			}

			updateState((state) => ({
				...state,
				health: 'network_wait',
				statusMessage: 'Tunnel failed for a non-auth reason. Retrying soon.',
				lastError: message,
				tunnelUrl: undefined,
				connectionId: undefined
			}))
			console.error(`${packageCommand} tunnel error: ${message}`.red)
			await sleep(10_000)
		}
	} finally {
		process.off('SIGINT', stop)
		process.off('SIGTERM', stop)
		await mcpServer.close().catch(() => {})
		updateState((state) => ({
			...state,
			health: 'stopped',
			statusMessage: 'Daemon stopped.',
			pid: undefined,
			stoppedAt: new Date().toISOString(),
			tunnelUrl: undefined,
			connectionId: undefined
		}))
	}
}
