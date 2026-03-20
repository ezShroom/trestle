import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

async function ask(question: string, defaultValue?: string) {
	const rl = readline.createInterface({ input, output })

	try {
		const suffix = defaultValue ? ` [${defaultValue}]` : ''
		const value = (await rl.question(`${question}${suffix}: `)).trim()
		return value || defaultValue || ''
	} finally {
		rl.close()
	}
}

async function confirm(question: string, defaultValue = false) {
	const rl = readline.createInterface({ input, output })

	try {
		const suffix = defaultValue ? ' [Y/n]' : ' [y/N]'
		const value = (await rl.question(`${question}${suffix}: `)).trim().toLowerCase()
		if (!value) return defaultValue
		return value === 'y' || value === 'yes'
	} finally {
		rl.close()
	}
}

async function pause(message: string) {
	const rl = readline.createInterface({ input, output })

	try {
		await rl.question(`${message} `)
	} finally {
		rl.close()
	}
}

export { ask, confirm, pause }
