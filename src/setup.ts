import 'colors'
import os from 'node:os'
import { ensureInteractiveAuth } from './auth'
import { packageCommand } from './constants'
import { loadConfig, saveConfig } from './fs_state'
import { confirm, ask } from './prompt'
import { maybePrimeMacOsTcc } from './tcc'
import { installService, serviceInstallDescription, startService } from './service'

async function runSetup() {
	console.log(
		[
			`${packageCommand} will give Poke broad access to this computer.`,
			'That means a remote agent may eventually be able to see and act on a lot of local state.',
			"If that is not acceptable, stop here and don't install the background service."
		].join('\n').yellow
	)

	const accepted = await confirm('Do you want to continue with setup?', false)
	if (!accepted) {
		throw new Error('Setup cancelled.')
	}

	await ensureInteractiveAuth()

	const existingConfig = loadConfig()
	const defaultComputerName = existingConfig?.computerName || os.hostname()
	const computerName = await ask('Name this computer for Poke', defaultComputerName)

	await maybePrimeMacOsTcc()

	console.log(`\nRegistering ${serviceInstallDescription()}...`.cyan)
	await installService()
	console.log(`Starting ${serviceInstallDescription()}...`.cyan)
	await startService()

	const now = new Date().toISOString()
	saveConfig({
		computerName,
		port: existingConfig?.port ?? 7653,
		consentAcceptedAt: existingConfig?.consentAcceptedAt ?? now,
		createdAt: existingConfig?.createdAt ?? now,
		updatedAt: now
	})

	console.log(`\n${packageCommand} is installed and ${serviceInstallDescription()} has been started.`.green)
	console.log(`Use '${packageCommand} status' to inspect it.`.dim)
}

export { runSetup }
