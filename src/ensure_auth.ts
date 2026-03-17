import { $ } from 'bun'

export async function ensureAuth() {
	while (true) {
		try {
			return (await $`bun poke whoami`.quiet()).text()
		} catch {
			while (true) {
				console.log('bunx poke login'.dim)
				try {
					await $`bun poke login`
					break
				} catch {
					prompt(
						`Authentication failed. Press ${process.platform === 'darwin' ? 'Return' : 'Enter'} to try again`
					)
				}
			}
		}
	}
}
