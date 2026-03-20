import { $ } from 'bun'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packageCommand, packageRoot, serviceLabel } from './constants'
import {
	entryScript,
	launchAgentFile,
	stderrLogFile,
	stdoutLogFile,
	systemdServiceFile,
	systemdUserDir
} from './paths'
import { ensureAppDirs } from './fs_state'
import { formatError } from './runtime'
import type { ServiceStatus } from './types'

function serviceCommandLine() {
	const bunPath = process.execPath
	return [bunPath, entryScript, 'daemon']
}

function serviceInstallDescription(platform = process.platform) {
	switch (platform) {
		case 'darwin':
			return 'a launchd LaunchAgent'
		case 'linux':
			return 'a systemd user service'
		case 'win32':
			return 'a Windows Scheduled Task'
		default:
			return 'a background service'
	}
}

function quoteWindowsArgument(value: string) {
	return `"${value.replaceAll('"', '\\"')}"`
}

async function installService() {
	ensureAppDirs()

	switch (process.platform) {
		case 'darwin':
			return installLaunchAgent()
		case 'linux':
			return installSystemdUserService()
		case 'win32':
			return installWindowsTask()
		default:
			throw new Error(`Unsupported platform: ${process.platform}`)
	}
}

async function startService() {
	switch (process.platform) {
		case 'darwin':
			await $`launchctl bootstrap gui/${String(process.getuid?.() ?? 0)} ${launchAgentFile}`.nothrow()
			await $`launchctl kickstart -k gui/${String(process.getuid?.() ?? 0)}/${serviceLabel}`.nothrow()
			return
		case 'linux':
			await $`systemctl --user daemon-reload`.nothrow()
			await $`systemctl --user enable --now ${serviceLabel}.service`
			return
		case 'win32':
			await $`schtasks /Run /TN ${serviceLabel}`
			return
		default:
			throw new Error(`Unsupported platform: ${process.platform}`)
	}
}

async function stopService() {
	switch (process.platform) {
		case 'darwin':
			await $`launchctl bootout gui/${String(process.getuid?.() ?? 0)}/${serviceLabel}`.nothrow()
			return
		case 'linux':
			await $`systemctl --user stop ${serviceLabel}.service`.nothrow()
			return
		case 'win32':
			await $`schtasks /End /TN ${serviceLabel}`.nothrow()
			return
		default:
			throw new Error(`Unsupported platform: ${process.platform}`)
	}
}

async function uninstallService() {
	switch (process.platform) {
		case 'darwin':
			await stopService()
			if (fs.existsSync(launchAgentFile)) fs.rmSync(launchAgentFile, { force: true })
			return
		case 'linux':
			await stopService()
			await $`systemctl --user disable ${serviceLabel}.service`.nothrow()
			if (fs.existsSync(systemdServiceFile)) fs.rmSync(systemdServiceFile, { force: true })
			await $`systemctl --user daemon-reload`.nothrow()
			return
		case 'win32':
			await stopService()
			await $`schtasks /Delete /TN ${serviceLabel} /F`.nothrow()
			return
		default:
			throw new Error(`Unsupported platform: ${process.platform}`)
	}
}

async function getServiceStatus(): Promise<ServiceStatus> {
	try {
		switch (process.platform) {
			case 'darwin': {
				if (!fs.existsSync(launchAgentFile)) {
					return { installed: false, running: false, details: 'LaunchAgent not installed.' }
				}
				const result =
					await $`launchctl print gui/${String(process.getuid?.() ?? 0)}/${serviceLabel}`.quiet().nothrow()
				return {
					installed: true,
					running: result.exitCode === 0,
					details:
						result.exitCode === 0
							? 'launchd reports the agent is loaded.'
							: result.stderr.toString().trim() || 'launchd reports the agent is not loaded.'
				}
			}
			case 'linux':
			{
				if (!fs.existsSync(systemdServiceFile)) {
					return { installed: false, running: false, details: 'systemd user service not installed.' }
				}
				const isActive = await $`systemctl --user is-active ${serviceLabel}.service`.quiet().nothrow()
				return {
					installed: true,
					running: isActive.exitCode === 0,
					details: isActive.stdout.toString().trim() || isActive.stderr.toString().trim() || 'unknown'
				}
			}
			case 'win32': {
				const query = await $`schtasks /Query /TN ${serviceLabel} /FO LIST /V`.quiet().nothrow()
				if (query.exitCode !== 0) {
					return { installed: false, running: false, details: query.stderr.toString().trim() || 'Task missing.' }
				}
				const details = query.stdout.toString().trim()
				return {
					installed: true,
					running: /Status:\s+Running/i.test(details),
					details
				}
			}
			default:
				return { installed: false, running: false, details: `Unsupported platform: ${process.platform}` }
		}
	} catch (error) {
		return {
			installed: false,
			running: false,
			details: formatError(error)
		}
	}
}

async function installLaunchAgent() {
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
    ${serviceCommandLine()
			.map((arg) => `    <string>${escapeXml(arg)}</string>`)
			.join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(packageRoot)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLogFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLogFile)}</string>
</dict>
</plist>
`

	fs.mkdirSync(path.dirname(launchAgentFile), { recursive: true })
	fs.writeFileSync(launchAgentFile, plist)
}

async function installSystemdUserService() {
	const service = `[Unit]
Description=${packageCommand} background daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${packageRoot}
ExecStart=${serviceCommandLine().map(escapeSystemdArgument).join(' ')}
Restart=always
RestartSec=5
StandardOutput=append:${stdoutLogFile}
StandardError=append:${stderrLogFile}

[Install]
WantedBy=default.target
`

	fs.mkdirSync(systemdUserDir, { recursive: true })
	fs.writeFileSync(systemdServiceFile, service)
	await $`systemctl --user daemon-reload`.nothrow()
}

async function installWindowsTask() {
	const command = serviceCommandLine().map(quoteWindowsArgument).join(' ')
	await $`schtasks /Create /SC ONLOGON /TN ${serviceLabel} /TR ${command} /F`
}

function escapeXml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

function escapeSystemdArgument(value: string) {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export { getServiceStatus, installService, serviceInstallDescription, startService, stopService, uninstallService }
