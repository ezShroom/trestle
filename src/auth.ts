import { $ } from 'bun'
import 'colors'
import { packageRoot } from './constants'
import { formatError, isPokeLoginMessage, sleep } from './runtime'

interface AuthCheckResult {
	ok: boolean
	authRequired: boolean
	message: string
}

async function checkPokeAuth(): Promise<AuthCheckResult> {
	const whoami = await $`bun poke whoami`.quiet().cwd(packageRoot).nothrow()
	const stderr = whoami.stderr.toString().trim()
	const stdout = whoami.stdout.toString().trim()

	if (whoami.exitCode === 0) {
		return {
			ok: true,
			authRequired: false,
			message: stdout || 'Authenticated.'
		}
	}

	const message = stderr || stdout || `poke whoami exited with code ${whoami.exitCode}`
	return {
		ok: false,
		authRequired: isPokeLoginMessage(message),
		message
	}
}

async function ensureInteractiveAuth() {
	while (true) {
		const auth = await checkPokeAuth()
		if (auth.ok) return

		if (!auth.authRequired) {
			console.error(auth.message)
			console.error('Waiting 10 seconds before checking again...'.magenta.bold)
			await sleep(10_000)
			continue
		}

		while (true) {
			console.log('bun poke login'.dim)
			try {
				await $`bun poke login`.cwd(packageRoot)
				break
			} catch (error) {
				console.error(formatError(error))
			}
		}

		return
	}
}

export { checkPokeAuth, ensureInteractiveAuth }
