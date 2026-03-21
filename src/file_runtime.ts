import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
	defaultFileGrepLimit,
	defaultFileListLimit,
	defaultFileReadLimit,
	defaultFileReadOffset,
	defaultFileSnapshotTtlMs,
	maxFileGrepLimit,
	maxFileListLimit,
	maxFileReadLimit,
	maxFileSnapshots
} from './constants'

interface ReadInput {
	path: string
	offset?: number
	limit?: number
}

interface WriteInput {
	path: string
	content: string
}

interface EditInput {
	path: string
	snapshotId: string
	oldString: string
	newString: string
	replaceAll?: boolean
}

interface MultiEditInput {
	path: string
	snapshotId: string
	edits: Array<{
		oldString: string
		newString: string
		replaceAll?: boolean
	}>
}

interface ListInput {
	path: string
	recursive?: boolean
	limit?: number
}

interface GlobInput {
	pattern: string
	root?: string
	limit?: number
}

interface GrepInput {
	pattern: string
	root?: string
	include?: string[]
	exclude?: string[]
	limit?: number
	regex?: boolean
	caseSensitive?: boolean
}

interface SnapshotRecord {
	id: string
	filePath: string
	createdAt: string
	expiresAt: number
	fingerprint: string
	size: number
	mtimeMs: number
	isBinary: boolean
}

interface Fingerprint {
	fingerprint: string
	size: number
	mtimeMs: number
}

interface DirectoryEntryResult {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink' | 'other'
	size: number | null
	mtime: string | null
}

interface ApplyEditResult {
	text: string
	replacements: number
	firstChangedIndex: number
	lastChangedIndex: number
}

const imageExtensions = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.bmp',
	'.svg',
	'.ico',
	'.tiff',
	'.avif',
	'.heic'
])

function nowIso() {
	return new Date().toISOString()
}

function resolveFilePath(targetPath: string) {
	return path.resolve(targetPath)
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}

function normalizeReadOffset(offset?: number) {
	if (!offset || Number.isNaN(offset)) return defaultFileReadOffset
	return Math.max(1, Math.floor(offset))
}

function normalizeReadLimit(limit?: number) {
	if (!limit || Number.isNaN(limit)) return defaultFileReadLimit
	return clamp(Math.floor(limit), 1, maxFileReadLimit)
}

function normalizeListLimit(limit?: number) {
	if (!limit || Number.isNaN(limit)) return defaultFileListLimit
	return clamp(Math.floor(limit), 1, maxFileListLimit)
}

function normalizeGrepLimit(limit?: number) {
	if (!limit || Number.isNaN(limit)) return defaultFileGrepLimit
	return clamp(Math.floor(limit), 1, maxFileGrepLimit)
}

function normalizePathForMatch(value: string) {
	return value.split(path.sep).join('/')
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globPatternToRegExp(pattern: string) {
	let result = '^'
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? ''
		const nextChar = pattern[index + 1]
		const thirdChar = pattern[index + 2]
		if (char === '*' && nextChar === '*' && (thirdChar === '/' || thirdChar === '\\')) {
			result += '(?:.*/)?'
			index += 2
			continue
		}
		if (char === '*' && nextChar === '*') {
			result += '.*'
			index += 1
			continue
		}
		if (char === '*') {
			result += '[^/]*'
			continue
		}
		if (char === '?') {
			result += '[^/]'
			continue
		}
		if (char === '\\' || char === '/') {
			result += '/'
			continue
		}
		result += escapeRegex(char)
	}
	result += '$'
	return new RegExp(result)
}

function deriveGlobRoot(pattern: string, root?: string) {
	if (root) return resolveFilePath(root)

	const isAbsolute = path.isAbsolute(pattern)
	const normalizedPattern = normalizePathForMatch(isAbsolute ? pattern : path.join(process.cwd(), pattern))
	const segments = normalizedPattern.split('/')
	const staticSegments: string[] = []

	for (const segment of segments) {
		if (segment.includes('*') || segment.includes('?')) break
		staticSegments.push(segment)
	}

	const joined = staticSegments.join('/')
	if (!joined) return process.platform === 'win32' ? process.cwd().slice(0, 3) : '/'
	if (/^[A-Za-z]:$/.test(joined)) return `${joined}/`
	return joined.startsWith('/') ? joined : `/${joined}`
}

function fingerprintBuffer(buffer: Buffer) {
	return createHash('sha256').update(buffer).digest('hex')
}

function describePath(filePath: string) {
	const stats = fs.lstatSync(filePath)
	const extension = path.extname(filePath).toLowerCase()
	const type = stats.isDirectory()
		? 'directory'
		: stats.isFile()
			? imageExtensions.has(extension)
				? 'image'
				: 'file'
			: stats.isSymbolicLink()
				? 'symlink'
				: 'other'
	return {
		path: filePath,
		name: path.basename(filePath),
		type,
		size: stats.isFile() ? stats.size : null,
		mtime: Number.isFinite(stats.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null
	}
}

function isProbablyBinary(buffer: Buffer) {
	if (buffer.length === 0) return false
	const sample = buffer.subarray(0, Math.min(buffer.length, 8_192))
	let suspicious = 0
	for (const byte of sample) {
		if (byte === 0) return true
		if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
	}
	return suspicious / sample.length > 0.3
}

function splitTextLines(text: string) {
	if (text.length === 0) return [] as string[]
	const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
	if (text.endsWith('\n')) lines.pop()
	return lines
}

function renderNumberedLines(lines: string[], startLine: number) {
	if (lines.length === 0) return ''
	return lines.map((line, index) => `${String(startLine + index)}\t${line}`).join('\n')
}

function charIndexToLine(text: string, charIndex: number) {
	if (charIndex <= 0) return 1
	let line = 1
	for (let index = 0; index < Math.min(charIndex, text.length); index += 1) {
		if (text[index] === '\n') line += 1
	}
	return line
}

function buildPreview(text: string, firstChangedIndex: number, lastChangedIndex: number) {
	const lines = splitTextLines(text)
	if (lines.length === 0) {
		return {
			startLine: 0,
			endLine: 0,
			content: ''
		}
	}

	const firstChangedLine = charIndexToLine(text, firstChangedIndex)
	const lastChangedLine = charIndexToLine(text, lastChangedIndex)
	const startLine = Math.max(1, firstChangedLine - 3)
	const endLine = Math.min(lines.length, lastChangedLine + 3)
	return {
		startLine,
		endLine,
		content: renderNumberedLines(lines.slice(startLine - 1, endLine), startLine)
	}
}

function validateTextEditInput(oldString: string, newString: string) {
	if (oldString.length === 0) throw new Error('oldString must not be empty.')
	if (oldString === newString) throw new Error('oldString and newString must differ.')
}

function applyTextEdit(text: string, oldString: string, newString: string, replaceAll = false): ApplyEditResult {
	validateTextEditInput(oldString, newString)
	const occurrences: number[] = []
	let searchIndex = 0
	while (true) {
		const index = text.indexOf(oldString, searchIndex)
		if (index === -1) break
		occurrences.push(index)
		searchIndex = index + oldString.length
	}

	if (occurrences.length === 0) {
		throw new Error('oldString was not found in the file.')
	}
	if (!replaceAll && occurrences.length > 1) {
		throw new Error('oldString is ambiguous. Set replaceAll to true or choose a more specific string.')
	}

	if (!replaceAll) {
		const start = occurrences[0] ?? 0
		return {
			text: `${text.slice(0, start)}${newString}${text.slice(start + oldString.length)}`,
			replacements: 1,
			firstChangedIndex: start,
			lastChangedIndex: start + newString.length
		}
	}

	let nextText = ''
	let cursor = 0
	for (const occurrence of occurrences) {
		nextText += text.slice(cursor, occurrence)
		nextText += newString
		cursor = occurrence + oldString.length
	}
	nextText += text.slice(cursor)
	const firstChangedIndex = occurrences[0] ?? 0
	const lastOccurrence = occurrences[occurrences.length - 1] ?? 0
	const lastChangedIndex = lastOccurrence + newString.length
	return {
		text: nextText,
		replacements: occurrences.length,
		firstChangedIndex,
		lastChangedIndex
	}
}

function writeTextFile(filePath: string, content: string) {
	const parentDir = path.dirname(filePath)
	if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
		throw new Error(`Parent directory does not exist: ${parentDir}`)
	}

	const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
	fs.writeFileSync(tempPath, content, 'utf8')
	fs.renameSync(tempPath, filePath)
}

class FileToolManager {
	private readonly snapshots = new Map<string, SnapshotRecord>()
	private readonly cleanupTimer: ReturnType<typeof setInterval>

	constructor() {
		this.cleanupTimer = setInterval(() => {
			this.expireSnapshots()
		}, 60_000)
		this.cleanupTimer.unref()
	}

	summary() {
		this.expireSnapshots()
		return {
			snapshotCount: this.snapshots.size
		}
	}

	read(input: ReadInput) {
		this.expireSnapshots()
		const filePath = resolveFilePath(input.path)
		if (!fs.existsSync(filePath)) {
			throw new Error(`Path does not exist: ${filePath}`)
		}

		const stats = fs.lstatSync(filePath)
		if (stats.isDirectory()) {
			throw new Error(`Path is a directory. Use ls instead: ${filePath}`)
		}
		if (!stats.isFile()) {
			throw new Error(`Path is not a regular file: ${filePath}`)
		}

		const buffer = fs.readFileSync(filePath)
		const snapshot = this.storeSnapshot(filePath, buffer, stats.mtimeMs)
		if (isProbablyBinary(buffer)) {
			return {
				path: filePath,
				snapshotId: snapshot.id,
				isText: false,
				isBinary: true,
				fileType: imageExtensions.has(path.extname(filePath).toLowerCase()) ? 'image' : 'binary',
				size: stats.size,
				mtime: new Date(stats.mtimeMs).toISOString(),
				message: 'Binary file detected. Read does not return raw binary content.',
				content: null
			}
		}

		const text = buffer.toString('utf8')
		const lines = splitTextLines(text)
		const offset = normalizeReadOffset(input.offset)
		const limit = normalizeReadLimit(input.limit)
		const startIndex = Math.min(lines.length, offset - 1)
		const selectedLines = lines.slice(startIndex, startIndex + limit)
		const endLine = selectedLines.length === 0 ? startIndex : startIndex + selectedLines.length
		const truncated = startIndex + selectedLines.length < lines.length

		return {
			path: filePath,
			snapshotId: snapshot.id,
			isText: true,
			isBinary: false,
			size: stats.size,
			mtime: new Date(stats.mtimeMs).toISOString(),
			offset,
			limit,
			startLine: selectedLines.length === 0 ? 0 : startIndex + 1,
			endLine,
			totalLines: lines.length,
			truncated,
			nextOffset: truncated ? startIndex + selectedLines.length + 1 : null,
			content: renderNumberedLines(selectedLines, startIndex + 1),
			guidance: truncated
				? `File output truncated. Re-read with offset ${String(startIndex + selectedLines.length + 1)} to continue.`
				: null
		}
	}

	write(input: WriteInput) {
		const filePath = resolveFilePath(input.path)
		writeTextFile(filePath, input.content)
		const buffer = fs.readFileSync(filePath)
		const stats = fs.statSync(filePath)
		const snapshot = this.storeSnapshot(filePath, buffer, stats.mtimeMs)
		return {
			path: filePath,
			written: true,
			size: stats.size,
			mtime: new Date(stats.mtimeMs).toISOString(),
			snapshotId: snapshot.id,
			preview: buildPreview(input.content, 0, Math.min(input.content.length, 1_000))
		}
	}

	edit(input: EditInput) {
		const filePath = resolveFilePath(input.path)
		const { text, snapshot } = this.readFreshTextFile(filePath, input.snapshotId)
		const result = applyTextEdit(text, input.oldString, input.newString, input.replaceAll)
		writeTextFile(filePath, result.text)
		const nextSnapshot = this.storeSnapshot(filePath, Buffer.from(result.text, 'utf8'), fs.statSync(filePath).mtimeMs)
		return {
			path: filePath,
			edited: true,
			replacements: result.replacements,
			snapshotId: nextSnapshot.id,
			previousSnapshotId: snapshot.id,
			preview: buildPreview(result.text, result.firstChangedIndex, result.lastChangedIndex)
		}
	}

	multiEdit(input: MultiEditInput) {
		const filePath = resolveFilePath(input.path)
		const { text, snapshot } = this.readFreshTextFile(filePath, input.snapshotId)
		let nextText = text
		let minChangedIndex = Number.POSITIVE_INFINITY
		let maxChangedIndex = 0
		const results: Array<{ replacements: number }> = []

		for (const edit of input.edits) {
			const applied = applyTextEdit(nextText, edit.oldString, edit.newString, edit.replaceAll)
			nextText = applied.text
			minChangedIndex = Math.min(minChangedIndex, applied.firstChangedIndex)
			maxChangedIndex = Math.max(maxChangedIndex, applied.lastChangedIndex)
			results.push({ replacements: applied.replacements })
		}

		writeTextFile(filePath, nextText)
		const nextSnapshot = this.storeSnapshot(filePath, Buffer.from(nextText, 'utf8'), fs.statSync(filePath).mtimeMs)
		return {
			path: filePath,
			edited: true,
			editCount: input.edits.length,
			results,
			snapshotId: nextSnapshot.id,
			previousSnapshotId: snapshot.id,
			preview: buildPreview(nextText, Number.isFinite(minChangedIndex) ? minChangedIndex : 0, maxChangedIndex)
		}
	}

	list(input: ListInput) {
		const targetPath = resolveFilePath(input.path)
		if (!fs.existsSync(targetPath)) {
			throw new Error(`Path does not exist: ${targetPath}`)
		}
		const stats = fs.lstatSync(targetPath)
		if (!stats.isDirectory()) {
			throw new Error(`Path is not a directory: ${targetPath}`)
		}

		const recursive = input.recursive ?? false
		const limit = normalizeListLimit(input.limit)
		const entries: DirectoryEntryResult[] = []
		const queue = [targetPath]

		while (queue.length > 0 && entries.length < limit) {
			const current = queue.shift() as string
			const children = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) =>
				left.name.localeCompare(right.name)
			)
			for (const child of children) {
				const childPath = path.join(current, child.name)
				const childStats = fs.lstatSync(childPath)
				const entryType = childStats.isDirectory()
					? 'directory'
					: childStats.isFile()
						? 'file'
						: childStats.isSymbolicLink()
							? 'symlink'
							: 'other'
				entries.push({
					path: childPath,
					name: child.name,
					type: entryType,
					size: childStats.isFile() ? childStats.size : null,
					mtime: new Date(childStats.mtimeMs).toISOString()
				})
				if (entries.length >= limit) break
				if (recursive && childStats.isDirectory() && !childStats.isSymbolicLink()) {
					queue.push(childPath)
				}
			}
		}

		return {
			path: targetPath,
			recursive,
			limit,
			truncated: entries.length >= limit,
			entries
		}
	}

	glob(input: GlobInput) {
		const root = deriveGlobRoot(input.pattern, input.root)
		if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) {
			throw new Error(`Glob root does not exist or is not a directory: ${root}`)
		}
		const limit = normalizeListLimit(input.limit)
		const absolutePattern = normalizePathForMatch(
			path.isAbsolute(input.pattern) ? input.pattern : path.join(process.cwd(), input.pattern)
		)
		const matcher = globPatternToRegExp(absolutePattern)
		const matches: string[] = []

		this.walk(root, (entryPath, entryStats) => {
			if (matches.length >= limit) return false
			if (matcher.test(normalizePathForMatch(entryPath))) {
				matches.push(entryPath)
			}
			return entryStats.isDirectory() ? undefined : undefined
		})

		return {
			pattern: input.pattern,
			root,
			limit,
			truncated: matches.length >= limit,
			matches
		}
	}

	grep(input: GrepInput) {
		const root = resolveFilePath(input.root ?? process.cwd())
		if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) {
			throw new Error(`Grep root does not exist or is not a directory: ${root}`)
		}

		const limit = normalizeGrepLimit(input.limit)
		const flags = input.caseSensitive ? 'g' : 'gi'
		const matcher = input.regex ? new RegExp(input.pattern, flags) : new RegExp(escapeRegex(input.pattern), flags)
		const includeMatchers = (input.include ?? []).map((pattern) => globPatternToRegExp(pattern))
		const excludeMatchers = (input.exclude ?? []).map((pattern) => globPatternToRegExp(pattern))
		const matches: Array<{ path: string; lineNumber: number; line: string }> = []

		this.walk(root, (entryPath, entryStats) => {
			if (matches.length >= limit) return false
			if (!entryStats.isFile()) return
			const relativePath = normalizePathForMatch(path.relative(root, entryPath))
			if (includeMatchers.length > 0 && !includeMatchers.some((regexp) => regexp.test(relativePath))) return
			if (excludeMatchers.some((regexp) => regexp.test(relativePath))) return

			const buffer = fs.readFileSync(entryPath)
			if (isProbablyBinary(buffer)) return
			const lines = splitTextLines(buffer.toString('utf8'))
			for (let index = 0; index < lines.length; index += 1) {
				matcher.lastIndex = 0
				if (!matcher.test(lines[index] ?? '')) continue
				matches.push({
					path: entryPath,
					lineNumber: index + 1,
					line: lines[index] ?? ''
				})
				if (matches.length >= limit) break
			}
		})

		return {
			pattern: input.pattern,
			root,
			limit,
			truncated: matches.length >= limit,
			matches
		}
	}

	async shutdown() {
		clearInterval(this.cleanupTimer)
		this.snapshots.clear()
	}

	private storeSnapshot(filePath: string, buffer: Buffer, mtimeMs: number) {
		this.expireSnapshots()
		if (this.snapshots.size >= maxFileSnapshots) {
			const oldest = [...this.snapshots.values()].sort((left, right) => left.expiresAt - right.expiresAt)[0]
			if (oldest) this.snapshots.delete(oldest.id)
		}

		const snapshot: SnapshotRecord = {
			id: randomUUID(),
			filePath,
			createdAt: nowIso(),
			expiresAt: Date.now() + defaultFileSnapshotTtlMs,
			fingerprint: fingerprintBuffer(buffer),
			size: buffer.length,
			mtimeMs,
			isBinary: isProbablyBinary(buffer)
		}
		this.snapshots.set(snapshot.id, snapshot)
		return snapshot
	}

	private requireSnapshot(snapshotId: string, filePath: string) {
		this.expireSnapshots()
		const snapshot = this.snapshots.get(snapshotId)
		if (!snapshot) throw new Error('snapshotId is missing, expired, or invalid. Call read again first.')
		if (snapshot.filePath !== filePath) {
			throw new Error(`snapshotId does not belong to ${filePath}`)
		}
		return snapshot
	}

	private readFreshTextFile(filePath: string, snapshotId: string) {
		if (!fs.existsSync(filePath)) {
			throw new Error(`Path does not exist: ${filePath}`)
		}
		const snapshot = this.requireSnapshot(snapshotId, filePath)
		const stats = fs.lstatSync(filePath)
		if (!stats.isFile()) {
			throw new Error(`Path is not a regular file: ${filePath}`)
		}
		const buffer = fs.readFileSync(filePath)
		if (isProbablyBinary(buffer) || snapshot.isBinary) {
			throw new Error(`Path is not a UTF-8 text file: ${filePath}`)
		}
		const current = this.computeFingerprint(buffer, stats.mtimeMs)
		if (
			current.fingerprint !== snapshot.fingerprint ||
			current.size !== snapshot.size ||
			Math.trunc(current.mtimeMs) !== Math.trunc(snapshot.mtimeMs)
		) {
			throw new Error('File changed since it was read. Call read again before editing.')
		}
		return {
			text: buffer.toString('utf8'),
			snapshot
		}
	}

	private computeFingerprint(buffer: Buffer, mtimeMs: number): Fingerprint {
		return {
			fingerprint: fingerprintBuffer(buffer),
			size: buffer.length,
			mtimeMs
		}
	}

	private expireSnapshots() {
		const now = Date.now()
		for (const [snapshotId, snapshot] of this.snapshots.entries()) {
			if (snapshot.expiresAt <= now) {
				this.snapshots.delete(snapshotId)
			}
		}
	}

	private walk(root: string, visitor: (entryPath: string, entryStats: fs.Stats) => boolean | void) {
		const queue = [root]
		while (queue.length > 0) {
			const current = queue.shift() as string
			const children = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) =>
				left.name.localeCompare(right.name)
			)
			for (const child of children) {
				const childPath = path.join(current, child.name)
				const childStats = fs.lstatSync(childPath)
				const shouldContinue = visitor(childPath, childStats)
				if (shouldContinue === false) return
				if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
					queue.push(childPath)
				}
			}
		}
	}
}

export { FileToolManager }
