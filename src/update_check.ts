import { $ } from 'bun'
import { Poke } from 'poke'
import { packageCommand, packageVersion } from './constants'
import { loadState, saveState } from './fs_state'
import { compareVersions, formatError, withTimeout } from './runtime'

async function maybeNotifyAboutUpdate() {
	const state = loadState()

	try {
		const latestVersion = await fetchLatestPublishedVersion()
		state.lastUpdateCheckAt = new Date().toISOString()
		state.latestKnownVersion = latestVersion
		saveState(state)

		if (compareVersions(latestVersion, packageVersion) <= 0) return
		if (state.lastUpdateNotificationVersion === latestVersion) return

		const poke = new Poke()
		const updateCommand = `bun install ${packageCommand}@latest --global`
		await withTimeout(
			poke.sendMessage(
				[
					`${packageCommand} ${packageVersion} is outdated; ${latestVersion} is available.`,
					`If the user wants to update, ask them to run: ${updateCommand}`,
					"Do not update without the user's consent unless they have explicitly allowed background self-updates.",
					'Also consider whether a currently running background agent might be using the tool right now.'
				].join(' ')
			),
			15_000,
			'Timed out while notifying Poke about an update.'
		)

		state.lastUpdateNotificationVersion = latestVersion
		saveState(state)
	} catch (error) {
		console.error(`Update check skipped: ${formatError(error)}`)
	}
}

async function fetchLatestPublishedVersion() {
	const command = $`bun info ${packageCommand} version --json`.quiet().nothrow()
	const result = await withTimeout(command, 15_000, 'Timed out while checking for updates.')
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString().trim() || 'bun info failed')
	}

	const rawOutput = result.stdout.toString().trim()
	if (!rawOutput) throw new Error('bun info returned an empty version response')

	try {
		return JSON.parse(rawOutput) as string
	} catch {
		return rawOutput
	}
}

export { maybeNotifyAboutUpdate }
