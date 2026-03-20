export type DaemonHealth =
	| 'idle'
	| 'starting'
	| 'running'
	| 'auth_required'
	| 'network_wait'
	| 'error'
	| 'stopped'

export interface AppConfig {
	computerName: string
	port: number
	consentAcceptedAt: string
	createdAt: string
	updatedAt: string
}

export interface AppState {
	pid?: number
	startedAt?: string
	stoppedAt?: string
	health: DaemonHealth
	statusMessage: string
	tunnelUrl?: string
	connectionId?: string
	lastError?: string
	lastAuthCheckAt?: string
	lastTunnelAttemptAt?: string
	lastUpdateCheckAt?: string
	lastUpdateNotificationVersion?: string
	latestKnownVersion?: string
}

export interface ServiceStatus {
	installed: boolean
	running: boolean
	details: string
}
