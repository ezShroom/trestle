import { $ } from 'bun'
import 'colors'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { packageCommand, serviceLabel } from './constants'
import { entryScript } from './paths'
import { confirm } from './prompt'
import { sleep } from './runtime'

type TccProbeKind =
	| 'accessibility'
	| 'automation'
	| 'screen-recording'
	| 'desktop-folder'
	| 'documents-folder'
	| 'downloads-folder'
	| 'full-disk-access'
	| 'contacts'
	| 'calendars'
	| 'reminders'
	| 'photos'

const detachedProbeTimeoutMs = 20_000
const permissionProbeIntervalMs = 400

async function maybePrimeMacOsTcc() {
	if (process.platform !== 'darwin') return

	const shouldPrime = await confirm(
		[
			'Do you want to walk through the macOS permissions that Poke may need?',
			'This opens the relevant macOS Privacy & Security panes now so Poke is less likely to get interrupted by permission prompts later.'
		].join(' '),
		true
	)
	if (!shouldPrime) return

	console.log(`\nSetting up macOS permissions for ${packageCommand}...`.cyan)
	console.log(
		[
			'This is a guided walkthrough.',
			'Some permissions will prompt immediately when probed.',
			'Others may only appear after first real use, so you can continue or skip any step and come back later in System Settings.'
		].join('\n').dim
	)

	await runPermissionStep({
		title: 'Accessibility',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
		kinds: ['accessibility'],
		instructions: [
			'Unlock the pane if needed.',
			'Approve Bun in the Accessibility list.'
		]
	})

	await runPermissionStep({
		title: 'Automation',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
		kinds: ['automation'],
		instructions: ['Approve Bun if macOS asks whether it may control Finder.']
	})

	await runPermissionStep({
		title: 'Screen Recording',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
		kinds: ['screen-recording'],
		instructions: [
			'Approve Bun for screen recording.',
			'If macOS says a restart is required, do that before expecting this probe to pass.'
		]
	})

	await runPermissionStep({
		title: 'Files And Folders',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
		kinds: ['desktop-folder', 'documents-folder', 'downloads-folder'],
		instructions: ['Approve Bun for Desktop, Documents, and Downloads access.']
	})

	await runPermissionStep({
		title: 'Full Disk Access',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
		kinds: ['full-disk-access'],
		instructions: ['Grant Bun Full Disk Access to avoid protected-file prompts later.']
	})

	await runPermissionStep({
		title: 'Contacts',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
		kinds: ['contacts'],
		instructions: ['Approve Bun for Contacts access.']
	})

	await runPermissionStep({
		title: 'Calendars',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
		kinds: ['calendars'],
		instructions: ['Approve Bun for Calendar access.']
	})

	await runPermissionStep({
		title: 'Reminders',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
		kinds: ['reminders'],
		instructions: ['Approve Bun for Reminders access.']
	})

	await runPermissionStep({
		title: 'Photos',
		pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Photos',
		kinds: ['photos'],
		instructions: ['Approve Bun for Photos access.']
	})

	await openPermissionPane('Input Monitoring', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
	await openPermissionPane('Camera', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
	await openPermissionPane('Microphone', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')

	console.log('\nmacOS permission walkthrough complete.'.green)
}

async function runPermissionStep({
	title,
	pane,
	kinds,
	instructions
}: {
	title: string
	pane: string
	kinds: TccProbeKind[]
	instructions: string[]
}) {
	console.log(`\n${title}`.cyan.bold)
	for (const instruction of instructions) {
		console.log(`- ${instruction}`)
	}

	await $`open ${pane}`.nothrow()
	console.log('Checking automatically. Press Enter to check immediately, or type "skip" then Enter to continue without it.'.dim)
	console.log(`Checking ${title}...`.dim)

	let lastFailureSummary = ''

	while (true) {
		const results = await Promise.all(kinds.map((kind) => runDetachedProbe(kind)))
		const failures = results.filter((result) => !result.ok)

		if (failures.length === 0) {
			console.log(`${title} granted.`.green)
			return
		}

		const failureSummary = failures.map((failure) => failure.message).filter(Boolean).join(' | ')
		if (failureSummary && failureSummary !== lastFailureSummary) {
			console.log(failureSummary.dim)
			lastFailureSummary = failureSummary
		}

		const action = await waitForLineOrTimeout(permissionProbeIntervalMs)
		if (action?.toLowerCase() === 'skip') {
			console.log(`${title} skipped for now.`.yellow)
			return
		}
	}
}

async function openPermissionPane(title: string, pane: string) {
	console.log(`\n${title}`.cyan.bold)
	await $`open ${pane}`.nothrow()
	await sleep(1_500)
}

async function runDetachedProbe(kind: TccProbeKind) {
	const resultFile = path.join(os.tmpdir(), `${serviceLabel}.${kind}.${Date.now()}.json`)
	const label = `${serviceLabel}.${kind}.${Date.now()}`

	try {
		const submit = await $`launchctl submit -l ${label} -- ${process.execPath} ${entryScript} tcc-probe ${kind} ${resultFile}`
			.quiet()
			.nothrow()

		if (submit.exitCode !== 0) {
			return {
				kind,
				ok: false,
				message: submit.stderr.toString().trim() || 'launchctl submit failed'
			}
		}

		for (let attempt = 0; attempt < detachedProbeTimeoutMs / 250; attempt += 1) {
			if (fs.existsSync(resultFile)) {
				const raw = fs.readFileSync(resultFile, 'utf8')
				return {
					kind,
					...(JSON.parse(raw) as { ok: boolean; message: string })
				}
			}

			await sleep(250)
		}

		return {
			kind,
			ok: false,
			message: 'Timed out waiting for the detached Bun probe to finish.'
		}
	} finally {
		await cleanupDetachedProbe(label, resultFile)
		fs.rmSync(resultFile, { force: true })
	}
}

async function runTccProbe(kind: TccProbeKind, resultFile: string) {
	const result = await probePermission(kind)
	fs.writeFileSync(resultFile, `${JSON.stringify(result)}\n`)
	process.exit(result.ok ? 0 : 1)
}

async function probePermission(kind: TccProbeKind) {
	try {
		switch (kind) {
			case 'accessibility':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "System Events" to count (every process)'])
				)
			case 'automation':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "Finder" to get name of startup disk'])
				)
			case 'screen-recording': {
				const screenshotPath = path.join(os.tmpdir(), `${serviceLabel}.screen-capture.png`)
				const result = await runCommandProbe('screencapture', ['-x', screenshotPath])
				fs.rmSync(screenshotPath, { force: true })
				return readProbeResult(result)
			}
			case 'desktop-folder':
				return probeDirectory(path.join(os.homedir(), 'Desktop'))
			case 'documents-folder':
				return probeDirectory(path.join(os.homedir(), 'Documents'))
			case 'downloads-folder':
				return probeDirectory(path.join(os.homedir(), 'Downloads'))
			case 'full-disk-access':
				return probeFullDiskAccess()
			case 'contacts':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "Contacts" to get name of first person'])
				)
			case 'calendars':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "Calendar" to get name of first calendar'])
				)
			case 'reminders':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "Reminders" to get name of first list'])
				)
			case 'photos':
				return readProbeResult(
					await runCommandProbe('osascript', ['-e', 'tell application "Photos" to get name of first album'])
				)
		}
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		}
	}
}

async function cleanupDetachedProbe(label: string, resultFile: string) {
	await $`launchctl remove ${label}`.quiet().nothrow()
	await $`pkill -TERM -f ${resultFile}`.quiet().nothrow()
	await sleep(250)
	await $`pkill -KILL -f ${resultFile}`.quiet().nothrow()
}

async function waitForLineOrTimeout(timeoutMs: number) {
	return await new Promise<string | null>((resolve) => {
		const onData = (chunk: Buffer | string) => {
			cleanup()
			resolve(String(chunk).trim())
		}

		const cleanup = () => {
			clearTimeout(timeout)
			process.stdin.off('data', onData)
			process.stdin.pause()
		}

		const timeout = setTimeout(() => {
			cleanup()
			resolve(null)
		}, timeoutMs)

		process.stdin.setEncoding('utf8')
		process.stdin.resume()
		process.stdin.once('data', onData)
	})
}

async function runCommandProbe(command: string, args: string[]) {
	return await new Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe']
		})

		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let settled = false

		const settle = (exitCode: number, stdout: Buffer, stderr: Buffer) => {
			if (settled) return
			settled = true
			resolve({ exitCode, stdout, stderr })
		}

		const timeout = setTimeout(() => {
			child.kill('SIGTERM')
			setTimeout(() => child.kill('SIGKILL'), 500)
			settle(124, Buffer.concat(stdoutChunks), Buffer.from('Probe timed out before finishing.'))
		}, detachedProbeTimeoutMs)

		child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
		child.on('error', (error) => {
			clearTimeout(timeout)
			settle(1, Buffer.concat(stdoutChunks), Buffer.from(String(error)))
		})
		child.on('close', (code) => {
			clearTimeout(timeout)
			settle(code ?? 1, Buffer.concat(stdoutChunks), Buffer.concat(stderrChunks))
		})
	})
}

function probeDirectory(directoryPath: string) {
	try {
		if (!fs.existsSync(directoryPath)) {
			return {
				ok: true,
				message: `${directoryPath} does not exist on this Mac.`
			}
		}

		fs.readdirSync(directoryPath)
		return {
			ok: true,
			message: `${directoryPath} is accessible.`
		}
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		}
	}
}

function probeFullDiskAccess() {
	const protectedPaths = [
		path.join(os.homedir(), 'Library', 'Mail'),
		path.join(os.homedir(), 'Library', 'Messages'),
		path.join(os.homedir(), 'Library', 'Safari')
	]

	const attempted: string[] = []

	for (const protectedPath of protectedPaths) {
		if (!fs.existsSync(protectedPath)) continue
		attempted.push(protectedPath)

		try {
			fs.readdirSync(protectedPath)
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			}
		}
	}

	if (attempted.length === 0) {
		return {
			ok: true,
			message: 'No protected Apple data folders were present to test.'
		}
	}

	return {
		ok: true,
		message: `Protected folders accessible: ${attempted.join(', ')}`
	}
}

function readProbeResult(result: { exitCode: number; stderr: Buffer; stdout: Buffer }) {
	return {
		ok: result.exitCode === 0,
		message:
			result.stderr.toString().trim() ||
			result.stdout.toString().trim() ||
			`Probe exited with code ${result.exitCode}`
	}
}

export { maybePrimeMacOsTcc, runTccProbe }
