#!/usr/bin/env bun

import 'colors'
import { Command } from 'commander'
import { packageCommand, packageVersion } from './constants'
import { runDaemon } from './daemon'
import { loadConfig, loadState, nukeLocalState } from './fs_state'
import { confirm } from './prompt'
import { runSetup } from './setup'
import { getServiceStatus, installService, startService, stopService, uninstallService } from './service'
import { maybePrimeMacOsTcc, runTccProbe } from './tcc'
import { formatError } from './runtime'

const program = new Command()

const setupRequiredCommands = new Set(['install', 'start', 'stop', 'uninstall', 'tcc-prime', 'daemon'])

program
	.name(packageCommand)
	.description('Local Poke computer-use bridge and background tunnel service.')
	.version(packageVersion)
	.showHelpAfterError()

program
	.command('install')
	.description('Install the background service using the existing config.')
	.action(async () => {
		await installService()
		console.log('Service installed.'.green)
	})

program
	.command('start')
	.description('Start the background service.')
	.action(async () => {
		await startService()
		console.log('Service started.'.green)
	})

program
	.command('stop')
	.description('Stop the background service.')
	.action(async () => {
		await stopService()
		console.log('Service stopped.'.yellow)
	})

program
	.command('uninstall')
	.description('Stop and unregister the background service.')
	.action(async () => {
		await uninstallService()
		console.log('Service uninstalled.'.yellow)
	})

program
	.command('nuke')
	.description('Stop everything, unregister the service, and delete local config/state so setup is required again.')
	.action(async () => {
		const approved = await confirm(
			`Really nuke ${packageCommand}? This removes the service, local config, state, and logs.`,
			false
		)
		if (!approved) {
			console.log('Nuke cancelled.'.dim)
			return
		}

		await uninstallService()
		nukeLocalState()
		console.log('Service, config, state, and logs removed. Next run will require setup again.'.yellow)
	})

program
	.command('status')
	.description('Print service and daemon status.')
	.action(async () => {
		const config = loadConfig()
		const state = loadState()
		const service = await getServiceStatus()

		console.log(`${packageCommand} ${packageVersion}`.magenta.bold)
		console.log(`Configured: ${config ? 'yes' : 'no'}`)
		console.log(`Computer name: ${config?.computerName ?? '-'}`)
		console.log(`Service installed: ${service.installed ? 'yes' : 'no'}`)
		console.log(`Service running: ${service.running ? 'yes' : 'no'}`)
		console.log(`Service details: ${service.details}`)
		console.log(`Daemon health: ${state.health}`)
		console.log(`Status: ${state.statusMessage}`)
		console.log(`Tunnel URL: ${state.tunnelUrl ?? '-'}`)
		console.log(`Connection ID: ${state.connectionId ?? '-'}`)
		console.log(`Last error: ${state.lastError ?? '-'}`)
		console.log(`Latest known version: ${state.latestKnownVersion ?? '-'}`)
	})

program
	.command('tcc-prime')
	.description('macOS only: try to trigger common TCC prompts up front.')
	.action(async () => {
		await maybePrimeMacOsTcc()
	})

program
	.command('daemon')
	.description('Run the local MCP server and Poke tunnel in the foreground.')
	.action(async () => {
		await runDaemon()
	})

program
	.command('tcc-probe <kind> <resultFile>', { hidden: true })
	.action(async (kind: Parameters<typeof runTccProbe>[0], resultFile: string) => {
		await runTccProbe(kind, resultFile)
	})

async function maybeRunImplicitSetup() {
	const args = process.argv.slice(2)
	const firstArg = args[0]
	const wantsHelp = firstArg === '--help' || firstArg === '-h'
	const wantsVersion = firstArg === '--version' || firstArg === '-V'
	const hasConfig = loadConfig() !== null

	if (hasConfig || wantsHelp || wantsVersion) return false

	if (!firstArg) {
		await runSetup()
		return true
	}

	if (setupRequiredCommands.has(firstArg)) {
		await runSetup()
		return true
	}

	return false
}

async function main() {
	const setupConsumedRun = await maybeRunImplicitSetup()
	if (setupConsumedRun) return

	if (!process.argv[2]) {
		program.outputHelp()
		return
	}

	await program.parseAsync(process.argv)
}

main().catch((error) => {
	console.error(formatError(error).red)
	process.exitCode = 1
})
