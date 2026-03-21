export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatError(error: unknown) {
	if (error instanceof Error) return error.message
	return String(error)
}

export function isPokeLoginMessage(text: string) {
	return text.includes('poke login')
}

export function compareVersions(left: string, right: string) {
	const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
	const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
	const length = Math.max(leftParts.length, rightParts.length)

	for (let index = 0; index < length; index += 1) {
		const leftValue = leftParts[index] ?? 0
		const rightValue = rightParts[index] ?? 0

		if (leftValue > rightValue) return 1
		if (leftValue < rightValue) return -1
	}

	return 0
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
	return Promise.race<T>([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(message)), timeoutMs)
		})
	])
}

export function normalizeComputerName(value: string) {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')

	return normalized || 'computer'
}
