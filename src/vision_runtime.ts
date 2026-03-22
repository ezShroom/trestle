import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js'
import { maxScreenshotDisplays, maxVisionImageBytes, serviceSlug } from './constants'

interface ReadImageInput {
	path: string
}

interface ScreenshotInput {
	display?: number
}

type VisionToolResult = CallToolResult

function resolveFilePath(targetPath: string) {
	return path.resolve(targetPath)
}

function mimeTypeForFile(filePath: string) {
	switch (path.extname(filePath).toLowerCase()) {
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.gif':
			return 'image/gif'
		case '.webp':
			return 'image/webp'
		case '.bmp':
			return 'image/bmp'
		case '.svg':
			return 'image/svg+xml'
		case '.ico':
			return 'image/x-icon'
		case '.tif':
		case '.tiff':
			return 'image/tiff'
		case '.avif':
			return 'image/avif'
		default:
			return null
	}
}

function imageBlockFromFile(filePath: string, mimeType: string): ImageContent {
	const buffer = fs.readFileSync(filePath)
	if (buffer.length > maxVisionImageBytes) {
		throw new Error(`Image exceeds ${String(maxVisionImageBytes)} bytes: ${filePath}`)
	}
	return {
		type: 'image',
		data: buffer.toString('base64'),
		mimeType
	}
}

function textBlock(text: string): TextContent {
	return {
		type: 'text',
		text
	}
}

function normalizeMacScreenCaptureError(stderr: string) {
	const message = stderr.trim()
	if (message.includes('could not create image from display 0')) {
		return 'macOS screencapture failed. Screen Recording permission may be missing, or capture is blocked in the current session.'
	}
	return message || 'screencapture failed'
}

async function runCommand(command: string, args: string[]) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8')
		})
		child.on('error', reject)
		child.on('close', (exitCode) => {
			resolve({
				exitCode: exitCode ?? 1,
				stdout,
				stderr
			})
		})
	})
}

function makeTempImagePath(extension = 'png') {
	return path.join(os.tmpdir(), `${serviceSlug}.vision.${randomUUID()}.${extension}`)
}

class VisionManager {
	async readImage(input: ReadImageInput): Promise<VisionToolResult> {
		const filePath = resolveFilePath(input.path)
		if (!fs.existsSync(filePath)) {
			throw new Error(`Path does not exist: ${filePath}`)
		}
		const stats = fs.lstatSync(filePath)
		if (!stats.isFile()) {
			throw new Error(`Path is not a regular file: ${filePath}`)
		}
		const mimeType = mimeTypeForFile(filePath)
		if (!mimeType) {
			throw new Error(`Unsupported image type: ${filePath}`)
		}

		return {
			content: [
				textBlock(
					JSON.stringify(
						{
							path: filePath,
							size: stats.size,
							mimeType
						},
						null,
						2
					)
				),
				imageBlockFromFile(filePath, mimeType)
			]
		}
	}

	async screenshot(input: ScreenshotInput): Promise<VisionToolResult> {
		switch (process.platform) {
			case 'darwin':
				return this.captureMacOs(input)
			case 'win32':
				return this.captureWindows(input)
			default:
				return this.captureLinux(input)
		}
	}

	private async captureMacOs(input: ScreenshotInput): Promise<VisionToolResult> {
		if (input.display) {
			return this.captureMacDisplay(input.display)
		}

		const displayCaptures: Array<{ display: number; filePath: string }> = []
		for (let display = 1; display <= maxScreenshotDisplays; display += 1) {
			const filePath = makeTempImagePath('png')
			const result = await runCommand('screencapture', ['-x', '-D', String(display), filePath])
			if (result.exitCode !== 0 || !fs.existsSync(filePath)) {
				fs.rmSync(filePath, { force: true })
				if (display === 1) {
					break
				}
				break
			}
			displayCaptures.push({ display, filePath })
		}

		if (displayCaptures.length === 0) {
			const filePath = makeTempImagePath('png')
			const result = await runCommand('screencapture', ['-x', filePath])
			if (result.exitCode !== 0 || !fs.existsSync(filePath)) {
				throw new Error(normalizeMacScreenCaptureError(result.stderr))
			}
			return this.buildScreenshotResult([{ display: null, filePath }], 'macos')
		}

		return this.buildScreenshotResult(
			displayCaptures.map((capture) => ({ display: capture.display, filePath: capture.filePath })),
			'macos'
		)
	}

	private async captureMacDisplay(display: number): Promise<VisionToolResult> {
		const filePath = makeTempImagePath('png')
		const result = await runCommand('screencapture', ['-x', '-D', String(display), filePath])
		if (result.exitCode !== 0 || !fs.existsSync(filePath)) {
			fs.rmSync(filePath, { force: true })
			throw new Error(normalizeMacScreenCaptureError(result.stderr))
		}
		return this.buildScreenshotResult([{ display, filePath }], 'macos')
	}

	private async captureWindows(input: ScreenshotInput): Promise<VisionToolResult> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${serviceSlug}.vision.`))
		const scriptPath = path.join(tempDir, 'capture.ps1')
		const outputPattern = path.join(tempDir, 'display')
		const displayClause =
			typeof input.display === 'number'
				? `$screens = @([System.Windows.Forms.Screen]::AllScreens[${String(Math.max(0, input.display - 1))}])`
				: '$screens = [System.Windows.Forms.Screen]::AllScreens'
		const script = [
			'Add-Type -AssemblyName System.Windows.Forms',
			'Add-Type -AssemblyName System.Drawing',
			displayClause,
			'$index = 0',
			'foreach ($screen in $screens) {',
			'  if ($null -eq $screen) { continue }',
			'  $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height',
			'  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
			'  $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)',
			`  $path = "${outputPattern}" + "-" + ($index + 1) + ".png"`,
			'  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
			'  $graphics.Dispose()',
			'  $bitmap.Dispose()',
			'  $index++',
			'}'
		].join('\n')
		fs.writeFileSync(scriptPath, script, 'utf8')

		const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath])
		if (result.exitCode !== 0) {
			fs.rmSync(tempDir, { recursive: true, force: true })
			throw new Error(result.stderr.trim() || 'PowerShell screenshot failed')
		}

		const files = fs
			.readdirSync(tempDir)
			.filter((name) => name.endsWith('.png'))
			.sort()
			.map((name, index) => ({ display: index + 1, filePath: path.join(tempDir, name) }))
		if (files.length === 0) {
			fs.rmSync(tempDir, { recursive: true, force: true })
			throw new Error('No screenshots were captured on Windows.')
		}
		return this.buildScreenshotResult(files, 'windows', tempDir)
	}

	private async captureLinux(input: ScreenshotInput): Promise<VisionToolResult> {
		const grimAvailable = (await runCommand('sh', ['-lc', 'command -v grim >/dev/null 2>&1'])).exitCode === 0
		const swaymsgAvailable = (await runCommand('sh', ['-lc', 'command -v swaymsg >/dev/null 2>&1'])).exitCode === 0
		if (grimAvailable && swaymsgAvailable) {
			const outputsResult = await runCommand('swaymsg', ['-t', 'get_outputs', '-r'])
			if (outputsResult.exitCode === 0) {
				const outputs = JSON.parse(outputsResult.stdout) as Array<{ name?: string; active?: boolean }>
				const activeOutputs = outputs.filter((output) => output.active && output.name)
				const selectedOutputs =
					typeof input.display === 'number'
						? activeOutputs.slice(input.display - 1, input.display)
						: activeOutputs.slice(0, maxScreenshotDisplays)
				const captures: Array<{ display: number; filePath: string }> = []
				for (const [index, output] of selectedOutputs.entries()) {
					if (!output.name) continue
					const filePath = makeTempImagePath('png')
					const result = await runCommand('grim', ['-o', output.name, filePath])
					if (result.exitCode !== 0 || !fs.existsSync(filePath)) {
						fs.rmSync(filePath, { force: true })
						throw new Error(result.stderr.trim() || `grim failed for output ${output.name}`)
					}
					captures.push({ display: index + 1, filePath })
				}
				if (captures.length > 0) {
					return this.buildScreenshotResult(captures, 'linux')
				}
			}
		}

		const candidates: Array<{ command: string; args: (filePath: string) => string[] }> = [
			{ command: 'grim', args: (filePath) => [filePath] },
			{ command: 'gnome-screenshot', args: (filePath) => ['-f', filePath] },
			{ command: 'scrot', args: (filePath) => ['-z', filePath] },
			{ command: 'import', args: (filePath) => ['-window', 'root', filePath] }
		]

		for (const candidate of candidates) {
			const check = await runCommand('sh', ['-lc', `command -v ${candidate.command} >/dev/null 2>&1`])
			if (check.exitCode !== 0) continue
			const filePath = makeTempImagePath('png')
			const result = await runCommand(candidate.command, candidate.args(filePath))
			if (result.exitCode !== 0 || !fs.existsSync(filePath)) {
				fs.rmSync(filePath, { force: true })
				continue
			}
			return this.buildScreenshotResult([{ display: null, filePath }], 'linux')
		}

		throw new Error('No supported Linux screenshot command was found. Tried grim, gnome-screenshot, scrot, and import.')
	}

	private buildScreenshotResult(
		captures: Array<{ display: number | null; filePath: string }>,
		platform: 'macos' | 'windows' | 'linux',
		cleanupDir?: string
	): VisionToolResult {
		try {
			const content: VisionToolResult['content'] = [
				textBlock(
					JSON.stringify(
						{
							platform,
							count: captures.length,
							displays: captures.map((capture) => ({
								display: capture.display,
								path: capture.filePath,
								mimeType: 'image/png',
								size: fs.statSync(capture.filePath).size
							}))
						},
						null,
						2
					)
				)
			]

			for (const capture of captures) {
				content.push(imageBlockFromFile(capture.filePath, 'image/png'))
			}

			return { content }
		} finally {
			for (const capture of captures) {
				fs.rmSync(capture.filePath, { force: true })
			}
			if (cleanupDir) {
				fs.rmSync(cleanupDir, { recursive: true, force: true })
			}
		}
	}
}

export { VisionManager }
