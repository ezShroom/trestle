import { $ } from 'bun'
import path from 'node:path'

const dir = path.join(import.meta.dirname, '../')

export async function ensureAuth() {
	while (true) {
		try {
			return (await $`bun poke whoami`.quiet().cwd(dir)).text()
		} catch {
			while (true) {
				console.log('bunx poke login'.dim)
				try {
					await $`bun poke login`.cwd(dir)
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
