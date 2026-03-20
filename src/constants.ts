import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json'

const packageName = String(packageJson.name)
const packageVersion = String(packageJson.version)
const packageRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packageCommand = packageName.replace(/^@[^/]+\//, '')
const serviceSlug = packageCommand.replace(/[^a-zA-Z0-9_.-]/g, '-')
const serviceLabel = `com.${serviceSlug}.daemon`
const defaultMcpPort = 7653
const defaultMcpHost = '127.0.0.1'
const defaultMcpPath = '/mcp'

export {
	defaultMcpHost,
	defaultMcpPath,
	defaultMcpPort,
	packageCommand,
	packageName,
	packageRoot,
	packageVersion,
	serviceLabel,
	serviceSlug
}
