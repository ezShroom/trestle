import fs from 'node:fs'
import { configDir, configFile, logDir, stateFile } from './paths'
import type { AppConfig, AppState } from './types'

const defaultState: AppState = {
	health: 'idle',
	statusMessage: 'Not started yet.'
}

function ensureAppDirs() {
	fs.mkdirSync(configDir, { recursive: true })
	fs.mkdirSync(logDir, { recursive: true })
}

function loadConfig() {
	try {
		return JSON.parse(fs.readFileSync(configFile, 'utf8')) as AppConfig
	} catch {
		return null
	}
}

function saveConfig(config: AppConfig) {
	ensureAppDirs()
	overwriteJsonFile(configFile, config)
}

function loadState() {
	try {
		return { ...defaultState, ...(JSON.parse(fs.readFileSync(stateFile, 'utf8')) as AppState) }
	} catch {
		return { ...defaultState }
	}
}

function saveState(state: AppState) {
	ensureAppDirs()
	overwriteJsonFile(stateFile, state)
}

function updateState(updater: (state: AppState) => AppState) {
	const nextState = updater(loadState())
	saveState(nextState)
	return nextState
}

function overwriteJsonFile(filePath: string, payload: unknown) {
	const tempFile = `${filePath}.tmp`
	fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`)
	fs.renameSync(tempFile, filePath)
}

function nukeLocalState() {
	if (fs.existsSync(configFile)) fs.rmSync(configFile, { force: true })
	if (fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true })
	if (fs.existsSync(logDir)) fs.rmSync(logDir, { recursive: true, force: true })

	try {
		fs.rmdirSync(configDir)
	} catch {}
}

export { ensureAppDirs, loadConfig, loadState, nukeLocalState, saveConfig, saveState, updateState }
