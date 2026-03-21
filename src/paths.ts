import os from 'node:os'
import path from 'node:path'
import { defaultMcpPath, packageCommand, packageRoot, serviceLabel } from './constants'

function resolveConfigBaseDir() {
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', packageCommand)
	}

	if (process.platform === 'win32') {
		const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
		return path.join(appData, packageCommand)
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
	return path.join(xdgConfigHome, packageCommand)
}

const configDir = resolveConfigBaseDir()
const configFile = path.join(configDir, 'config.json')
const stateFile = path.join(configDir, 'state.json')
const logDir = path.join(configDir, 'logs')
const terminalLogDir = path.join(logDir, 'terminal')
const stdoutLogFile = path.join(logDir, 'daemon.stdout.log')
const stderrLogFile = path.join(logDir, 'daemon.stderr.log')
const launchAgentFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceLabel}.plist`)
const systemdUserDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user')
const systemdServiceFile = path.join(systemdUserDir, `${serviceLabel}.service`)
const entryScript = path.join(packageRoot, 'src', 'index.ts')

function localMcpUrl(port: number) {
	return `http://127.0.0.1:${port}${defaultMcpPath}`
}

export {
	configDir,
	configFile,
	entryScript,
	launchAgentFile,
	localMcpUrl,
	logDir,
	stateFile,
	stderrLogFile,
	stdoutLogFile,
	terminalLogDir,
	systemdServiceFile,
	systemdUserDir
}
