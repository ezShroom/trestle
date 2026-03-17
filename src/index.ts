#!/usr/bin/env bun

import { ensureAuth } from './ensure_auth'
import { version } from '../package.json'
import 'colors'

console.log(`trestle ${String(version).white}\n`.magenta.bold)
ensureAuth()
