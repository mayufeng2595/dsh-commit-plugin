/**
 * dsh-git-commit — Host half.
 *
 * One same-origin HTTP surface backs the sidebar panel:
 *
 *   POST /dsh-git-commit/api/<status|diff|commit>
 *     -> { ok: true, data } | { ok: false, error: { code, message } }
 *
 * Every git call is an argv array (never a shell string) executed in the
 * project directory the panel names. Reads (status, diff) are cheap and
 * unprivileged; `commit` and the branch/sync family (`branches`, `fetch`,
 * `pull`, `push`, `checkout`, `branch`, `merge`, `rebase`, `compare`,
 * `tracking`, `stash`, `remotes`, `remote`) are writes or read the branch
 * table, and each names its own target explicitly.
 *
 * The same commit routine backs the optional `git_commit` agent tool. Its
 * permission mode is deployment configuration: `forbid` registers no tool,
 * `confirm` routes every call through DSH's approval prompt, and `allow` runs
 * it directly.
 *
 * `placement` is the one preference the user owns at runtime. It is a
 * `volatile` Config field, which the DSH settings service projects into a form
 * on this bundle's 插件 page; a choice made there is written into the active
 * profile's cordis patch, overrides `cordis.patch.yml`, and lands in the
 * running entry without a restart. Every other field is deployment
 * configuration and stays out of that form.
 */

import { spawn } from 'node:child_process'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Prefix the browser calls; mount-relative in the Client. */
export const ROUTE_PREFIX = '/dsh-git-commit/api'

const MAX_BODY_BYTES = 1 << 20
const GIT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DIFF_CHARS = 400 * 1024
const MAX_MESSAGE_CHARS = 20_000
/** Tools that write files; their successful results mark Session-touched paths. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

export const name = 'git-commit'
export const inject = ['webServer']

/**
 * This plugin's configuration schema. `placement` carries `.volatile()`, which
 * is what makes it a live setting: the DSH Loader keeps a running reference to
 * it, the settings form writes it into the profile patch, and the entry keeps
 * running. Ordinary fields here stay file-only by design.
 */
export const Config = z.object({
  /** Which seat the browser half mounts the panel into. */
  placement: z.union(['tab', 'sidebar']).default('tab').volatile(),
  /** Whether the agent may commit, and whether it needs approval. */
  agentCommit: z.union(['forbid', 'confirm', 'allow']).default('confirm'),
  gitBinary: z.string().default('git'),
  initBranch: z.string().default('main'),
  initScaffold: z.boolean().default(true),
  maxDiffChars: z.number().default(DEFAULT_MAX_DIFF_CHARS),
})

/** One request-level failure with its HTTP status. */
class ApiError extends Error {
  /**
   * @param {string} code - stable machine code returned to the Client.
   * @param {string} message - user-facing reason.
   * @param {number} [status] - HTTP status.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Compose the git surface and the optional agent tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - row configuration from the patch layer.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  /** Session id -> raw paths reported by successful write-tool calls. */
  const touchedBySession = new Map()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => { void handleRequest(req, res, settings, touchedBySession, ctx) },
  }), 'dsh-git-commit: git routes')

  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    if (result.isError === true) return
    const sessionId = exec.agent?.id
    if (sessionId === undefined) return
    const paths = touchedPathsOf(exec.name, exec.arguments)
    if (paths.length === 0) return
    const entry = touchedBySession.get(sessionId) ?? new Set()
    for (const path of paths) entry.add(path)
    if (entry.size > 400) {
      const overflow = [...entry].slice(0, entry.size - 400)
      for (const path of overflow) entry.delete(path)
    }
    touchedBySession.set(sessionId, entry)
    while (touchedBySession.size > 64) {
      const oldest = touchedBySession.keys().next().value
      if (oldest === undefined) break
      touchedBySession.delete(oldest)
    }
  }), 'dsh-git-commit: session-touched files')

  if (settings.agentCommit !== 'forbid') {
    ctx.inject(['tools', 'workingDirectory'], (injected) => {
      const tools = injected.get('tools')
      const workingDirectory = injected.get('workingDirectory')
      if (tools === undefined || workingDirectory === undefined) return
      injected.effect(() => tools.register(commitTool(settings, workingDirectory, touchedBySession)), 'dsh-git-commit: git_commit tool')
      if (settings.agentCommit === 'confirm') {
        injected.effect(() => injected.on('tools/pre-execute', async (exec, next) => {
          if (exec.name !== 'git_commit') return next()
          return {
            kind: 'ask',
            reason: 'Commit the current uncommitted changes of this project',
            displayReason: {
              en: 'Commit the selected project changes?',
              zh: '要提交这个项目的改动吗？',
            },
          }
        }), 'dsh-git-commit: commit approval')
      }
    })
  }
}

/**
 * Read the row configuration with defaults.
 * @param {object | undefined} config - patch row configuration.
 * @returns {{ agentCommit: 'forbid' | 'confirm' | 'allow', placement: 'tab' | 'sidebar', gitBinary: string, maxDiffChars: number }} normalized settings.
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  const mode = raw.agentCommit
  // A volatile Config field arrives as a live reference, so `placement` has to
  // be read per use: after a settings write the Loader commits the new value
  // into that same reference and the read below follows it.
  const placement = isVolatileRef(raw.placement) ? raw.placement : null
  return {
    agentCommit: mode === 'forbid' || mode === 'allow' ? mode : 'confirm',
    get placement() {
      const value = placement === null ? raw.placement : placement.get()
      return value === 'sidebar' ? 'sidebar' : 'tab'
    },
    gitBinary: typeof raw.gitBinary === 'string' && raw.gitBinary.trim() !== '' ? raw.gitBinary.trim() : 'git',
    initBranch: typeof raw.initBranch === 'string' && raw.initBranch.trim() !== '' ? raw.initBranch.trim() : 'main',
    initScaffold: raw.initScaffold !== false,
    maxDiffChars: Number.isInteger(raw.maxDiffChars) && raw.maxDiffChars >= 10_000 ? raw.maxDiffChars : DEFAULT_MAX_DIFF_CHARS,
  }
}

/**
 * Whether a resolved config value is a volatile reference rather than a plain
 * value. Duck-typed so the host keeps working on a deployment whose Loader
 * hands out ordinary values.
 * @param {unknown} value - one resolved configuration field.
 * @returns {boolean} whether `.get()` reads the live value.
 */
function isVolatileRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

/* ============================== HTTP ============================== */

/**
 * Route one API request.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context for logging.
 * @returns {Promise<void>} settles after the response is written.
 */
async function handleRequest(req, res, settings, touchedBySession, ctx) {
  if (!isTrusted(req)) {
    sendJson(res, 403, fail('forbidden', 'forbidden'))
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, fail('method-error', 'POST required'))
    return
  }
  const contentType = headerOf(req, 'content-type')
  if (contentType !== undefined && contentType !== '' && !contentType.toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, fail('unsupported-media-type', 'application/json required'))
    return
  }
  const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://dsh.internal').pathname
  const method = pathname.startsWith(ROUTE_PREFIX + '/') ? pathname.slice(ROUTE_PREFIX.length + 1) : ''
  if (method === '' || method.includes('/')) {
    sendJson(res, 404, fail('not-found', `unknown method "${method}"`))
    return
  }
  try {
    const payload = await readJsonBody(req)
    let data
    if (method === 'config') {
      data = { placement: settings.placement }
    } else if (method === 'status') {
      data = await statusOf(payload.cwd, payload.sessionId, settings, touchedBySession)
    } else if (method === 'preview') {
      data = await previewOf(payload.cwd, payload.path, payload.origPath, settings)
    } else if (method === 'diff') {
      data = await diffOf(payload.cwd, payload.path, payload.origPath, settings)
    } else if (method === 'commit') {
      data = await commitOf(payload.cwd, payload.sessionId, payload.message, payload.paths, settings, touchedBySession, payload.push === true)
    } else if (method === 'discover') {
      data = await discoverOf(payload.cwd, settings, payload.refresh === true)
    } else if (method === 'init') {
      data = await initOf(payload.cwd, payload.sessionId, settings, touchedBySession)
    } else if (method === 'read') {
      data = await readTextOf(payload.cwd, payload.path, settings)
    } else if (method === 'write') {
      data = await writeTextOf(payload.cwd, payload.path, payload.content, settings)
    } else if (method === 'rollback') {
      data = await rollbackOf(payload.cwd, payload.sessionId, payload.paths, settings, touchedBySession)
    } else if (method === 'branches') {
      data = await branchesOf(payload.cwd, settings)
    } else if (method === 'fetch') {
      data = await fetchOf(payload.cwd, payload.sessionId, payload.remote, settings, touchedBySession)
    } else if (method === 'pull') {
      data = await pullOf(payload.cwd, payload.sessionId, payload.strategy, settings, touchedBySession)
    } else if (method === 'push') {
      data = await pushNowOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'checkout') {
      data = await checkoutOf(payload.cwd, payload.sessionId, payload.rev, payload.smart, settings, touchedBySession)
    } else if (method === 'branch') {
      data = await branchOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'merge') {
      data = await mergeOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'rebase') {
      data = await rebaseOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'compare') {
      data = await compareOf(payload.cwd, payload.ref, payload.base, settings)
    } else if (method === 'tracking') {
      data = await trackingOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'stash') {
      data = await stashOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else if (method === 'remotes') {
      data = await remotesOf(payload.cwd, settings)
    } else if (method === 'remote') {
      data = await remoteOf(payload.cwd, payload.sessionId, payload, settings, touchedBySession)
    } else {
      throw new ApiError('not-found', `unknown method "${method}"`, 404)
    }
    sendJson(res, 200, { ok: true, data })
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status >= 500) ctx.logger?.warn(`dsh-git-commit: ${method} failed: ${error.message}`)
      sendJson(res, error.status, fail(error.code, error.message))
      return
    }
    ctx.logger?.warn(`dsh-git-commit: ${method} crashed: ${messageOf(error)}`)
    sendJson(res, 500, fail('internal', messageOf(error)))
  }
}

/**
 * Same-origin fence: a loopback authority or a browser-stamped same-origin request.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} whether the request may be served.
 */
function isTrusted(req) {
  const host = headerOf(req, 'host')
  if (host === undefined || host === '') return false
  const site = headerOf(req, 'sec-fetch-site')
  if (site !== undefined && site !== '' && site !== 'same-origin') return false
  const hostname = host.replace(/^\[/, '').replace(/\]:\d+$/, '').replace(/:\d+$/, '')
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true
  if (/^127\./.test(hostname)) return true
  return site === 'same-origin'
}

/**
 * Read one request header as a single value.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {string} name - lower-case header name.
 * @returns {string | undefined} the first value.
 */
function headerOf(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Write a JSON response body.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Read and parse the request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed object, empty for a blank body.
 */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('too-large', 'request body is too large', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolvePromise({}); return }
      try {
        const parsed = JSON.parse(raw)
        resolvePromise(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new ApiError('bad-json', 'request body must be JSON'))
      }
    })
    req.on('error', (error) => { reject(new ApiError('transport', messageOf(error), 500)) })
  })
}

/**
 * Build a failure envelope.
 * @param {string} code - machine code.
 * @param {string} message - reason.
 * @returns {{ ok: false, error: { code: string, message: string } }} envelope.
 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/* ============================== git plumbing ============================== */

/**
 * Run git with an argv array; resolves for any exit code.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @param {{ input?: string, timeoutMs?: number }} [options] - stdin and deadline.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<{ code: number | string, stdout: string, stderr: string, truncated: boolean }>} outcome.
 */
function runGit(cwd, args, options, settings) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(settings.gitBinary, args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
        },
      })
    } catch (error) {
      resolvePromise({ code: 'spawn-error', stdout: '', stderr: messageOf(error), truncated: false })
      return
    }
    const timeoutMs = options?.timeoutMs ?? GIT_TIMEOUT_MS
    const out = []
    const err = []
    let outBytes = 0
    let truncated = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (outBytes >= 8 * 1024 * 1024) { truncated = true; return }
      out.push(chunk)
      outBytes += chunk.length
    })
    child.stderr.on('data', (chunk) => { err.push(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 'spawn-error', stdout: '', stderr: messageOf(error), truncated })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({
        code: code === null ? 'killed' : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim(),
        truncated,
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options?.input ?? undefined)
  })
}

/**
 * Resolve one directory to its repository root.
 * @param {string} cwd - project directory.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<string>} absolute repository root.
 */
async function repoRoot(cwd, settings) {
  const directory = await requireDirectory(cwd)
  const result = await runGit(directory, ['rev-parse', '--show-toplevel'], undefined, settings)
  if (result.code !== 0) {
    throw new ApiError('not-a-repository', result.stderr || `${directory} is not a git repository`)
  }
  return result.stdout.trim()
}

/**
 * Validate an absolute project directory.
 * @param {unknown} cwd - caller-supplied directory.
 * @returns {Promise<string>} the directory.
 */
async function requireDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new ApiError('bad-directory', 'cwd must be an absolute directory path')
  }
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new ApiError('bad-directory', `cwd is not a readable directory: ${cwd}`, 404)
  }
  return cwd
}

/**
 * Validate one repository-relative path.
 * @param {string} root - repository root.
 * @param {unknown} path - caller-supplied path.
 * @returns {string} normalized relative path with forward slashes.
 */
function safeRelative(root, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || isAbsolute(path)) {
    throw new ApiError('bad-path', 'path must be repository-relative')
  }
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new ApiError('bad-path', `path escapes the repository: ${path}`)
  }
  return rel.split(sep).join('/')
}

/* ============================== status ============================== */

/**
 * Read the full uncommitted-change status of one project.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session whose tool-written files should be marked.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} status payload.
 */
/** Directories never descended into while scanning for repositories. */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'target', 'out', '__pycache__', '.next', '.venv', 'venv', '.idea', '.gradle', '.mvn'])

/** Largest number of directories one discovery scan visits. */
const SCAN_MAX_DIRECTORIES = 3000

/** Deepest nesting (workspace root = depth 0) the scan reaches. */
const SCAN_MAX_DEPTH = 4

/** Pending directories held in the breadth-first queue before the scan stops. */
const SCAN_MAX_QUEUED = 2000

/** Repositories reported per workspace scan; more stay behind `truncated`. */
const SCAN_MAX_RESULTS = 200

/** How long one workspace's scan stays fresh before a background rescan. */
const DISCOVERY_TTL_MS = 60_000

/** Workspace root -> { result, at } cached scan answers. */
const discoveryCache = new Map()

/** In-flight scans per workspace, so concurrent tabs share one pass. */
const discoveryInFlight = new Map()

/**
 * Find every git repository under one workspace directory.
 *
 * Breadth-first over real directories only (no symlink loops), skipping
 * dependency and build folders, capped by depth, visit count, and result
 * count: a large multi-project workspace answers in seconds, not minutes.
 * A directory counts as a repository through a cheap `.git` existence check
 * first; only its children are probed with git, so nested subprojects inside
 * one repo are still found without walking that repo's whole tree blindly.
 * @param {unknown} cwd - workspace directory.
 * @param {object} settings - normalized row configuration.
 * @param {boolean} refresh - ignore the cached answer.
 * @returns {Promise<{ repos: Array<{ path: string, name: string }>, truncated: boolean }>} discovery payload.
 */
async function discoverOf(cwd, settings, refresh) {
  let directory = await requireDirectory(cwd)
  try {
    const { realpath } = await import('node:fs/promises')
    directory = await realpath(directory)
  } catch {
    /* keep the supplied path when it cannot be canonicalized */
  }
  let stale = null
  if (refresh !== true) {
    const held = discoveryCache.get(directory)
    if (held !== undefined) {
      if (Date.now() - held.at < DISCOVERY_TTL_MS) return held.result
      stale = held.result
    }
    const pending = discoveryInFlight.get(directory)
    if (pending !== undefined) return pending
  }
  const attempt = scanWorkspace(directory, settings)
  discoveryInFlight.set(directory, attempt)
  try {
    const result = await attempt
    discoveryCache.set(directory, { result, at: Date.now() })
    return result
  } catch (error) {
    // A failed rescan keeps answering with the last good list.
    if (stale !== null) return stale
    throw error
  } finally {
    discoveryInFlight.delete(directory)
  }
}

/**
 * Strip any trailing separator for a stable directory comparison.
 * @param {string} path - directory path.
 * @returns {string} comparable path.
 */
function normalizeRoot(path) {
  return path.endsWith('/') || path.endsWith('\\') ? path.slice(0, -1) : path
}

/**
 * One breadth-first scan pass.
 * @param {string} root - absolute workspace directory.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<{ repos: Array<object>, truncated: boolean }>} scan result.
 */
async function scanWorkspace(root, settings) {
  /** @type {Array<{ path: string, name: string, depth: number }>} */
  const found = []
  let visited = 0
  let truncated = false
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift()
    visited += 1
    if (visited > SCAN_MAX_DIRECTORIES) { truncated = true; break }
    let isRepoDir = false
    if (depth > 0) {
      // Cheap marker first: no .git anywhere near means no git call at all.
      let hasMarker = false
      try {
        const { stat } = await import('node:fs/promises')
        const marker = await stat(`${dir}/.git`).catch(() => null)
        hasMarker = marker !== null
      } catch {
        hasMarker = false
      }
      if (hasMarker) {
        const probe = await runGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000 }, settings)
        isRepoDir = probe.code === 0 && normalizeRoot(probe.stdout.trim()) === normalizeRoot(dir)
        if (isRepoDir) {
          found.push({ path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir, depth })
          if (found.length >= SCAN_MAX_RESULTS) { truncated = true; break }
        }
      }
    }
    if (depth >= SCAN_MAX_DEPTH) continue
    let entries
    try {
      const { readdir } = await import('node:fs/promises')
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    let queuedHere = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (SCAN_SKIP_DIRS.has(name)) continue
      if (name.startsWith('.') && depth >= 1) continue
      // A repository root is one project: its own folders are not separate
      // candidates, so they neither count toward the crowded-folder cap nor
      // get walked at all. Only nested subprojects under plain folders matter.
      if (isRepoDir) continue
      if (queue.length >= SCAN_MAX_QUEUED) { truncated = true; break }
      queuedHere += 1
      queue.push({ dir: `${dir}/${name}`, depth: depth + 1 })
    }
  }
  found.sort((left, right) => left.path.localeCompare(right.path))
  return { repos: found.map(({ path, name }) => ({ path, name })), truncated }
}

/**
 * Create a git repository in a project directory and return its first status.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity for the touched-file marks.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} status payload of the new repository.
 */
async function initOf(cwd, sessionId, settings, touchedBySession) {
  const directory = await requireDirectory(cwd)
  const existing = await runGit(directory, ['rev-parse', '--show-toplevel'], undefined, settings)
  if (existing.code === 0) {
    // Already a repository (or inside one): report the status instead of failing.
    return await statusOf(directory, sessionId, settings, touchedBySession)
  }
  // Name the starting branch explicitly so the default does not depend on
  // the user's global `init.defaultBranch` setting.
  const init = await runGit(directory, ['init', '-b', settings.initBranch], undefined, settings)
  if (init.code !== 0) {
    throw new ApiError('init-failed', init.stderr || init.stdout || 'git init failed', 500)
  }
  const generated = await writeScaffold(directory, settings)
  // The scan cache must forget this folder so the repository shows up in the
  // project list immediately.
  discoveryCache.clear()
  const status = await statusOf(directory, sessionId, settings, touchedBySession)
  return { ...status, created: generated }
}

/** Files a fresh repository starts with, skipped when the path already exists. */
const SCAFFOLD = [
  {
    path: '.gitignore',
    body: [
      '# Dependencies',
      'node_modules/',
      '',
      '# Build output',
      'dist/',
      'build/',
      'out/',
      'target/',
      'bin/',
      'obj/',
      '',
      '# Editors and OS',
      '.idea/',
      '.vscode/',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# Logs and local settings',
      '*.log',
      '.env',
      '.env.local',
      '',
    ].join('\n'),
  },
]

/**
 * Write the starting files of a new repository without overwriting anything.
 * @param {string} directory - project directory.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<string[]>} paths actually created.
 */
async function writeScaffold(directory, settings) {
  if (settings.initScaffold === false) return []
  const created = []
  for (const file of SCAFFOLD) {
    const target = `${directory}/${file.path}`
    try {
      const { access, writeFile } = await import('node:fs/promises')
      await access(target)
      continue
    } catch {
      // Missing: create it below.
    }
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(target, file.body, 'utf8')
      created.push(file.path)
    } catch (error) {
      // A scaffold failure never fails the repository creation itself.
      void error
    }
  }
  return created
}

async function statusOf(cwd, sessionId, settings, touchedBySession) {
  const directory = await requireDirectory(cwd)
  const rootResult = await runGit(directory, ['rev-parse', '--show-toplevel'], undefined, settings)
  if (rootResult.code !== 0) {
    return {
      repo: null,
      reason: rootResult.stderr.toLowerCase().includes('not a git repository') ? 'not-a-repository' : 'git-unavailable',
      detail: rootResult.stderr,
      files: [],
      total: { files: 0, additions: 0, deletions: 0 },
    }
  }
  const root = rootResult.stdout.trim()
  const statusResult = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--branch'], undefined, settings)
  if (statusResult.code !== 0) {
    throw new ApiError('git-failed', statusResult.stderr || 'git status failed', 500)
  }
  const parsed = parseStatus(statusResult.stdout)
  const worktreeStats = parseNumstat((await runGit(root, ['diff', '--numstat', '-z'], undefined, settings)).stdout)
  const indexStats = parseNumstat((await runGit(root, ['diff', '--cached', '--numstat', '-z'], undefined, settings)).stdout)
  const touched = await touchedRelative(root, sessionId, touchedBySession)

  const files = []
  let additions = 0
  let deletions = 0
  let untrackedCounted = 0
  for (const entry of parsed.files) {
    const index = indexStats.get(entry.path)
    const worktree = worktreeStats.get(entry.path)
    let add = (index?.additions ?? 0) + (worktree?.additions ?? 0)
    let del = (index?.deletions ?? 0) + (worktree?.deletions ?? 0)
    const binary = index?.binary === true || worktree?.binary === true
    if (entry.kind === 'untracked') {
      // Counting lines is a file read per untracked file; bound it so a huge
      // generated directory cannot slow every poll.
      add = untrackedCounted < 50 ? await countFileLines(root, entry.path) : 0
      untrackedCounted += 1
    }
    additions += add
    deletions += del
    files.push({
      ...entry,
      additions: add,
      deletions: del,
      binary,
      touched: touched.has(entry.path) || (entry.origPath !== null && touched.has(entry.origPath)),
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))

  return {
    repo: {
      root,
      branch: parsed.branch,
      detached: parsed.detached,
      head: parsed.oid === null || !/^[0-9a-f]{7,40}$/i.test(parsed.oid) ? null : parsed.oid.slice(0, 7),
      ahead: parsed.ahead,
      behind: parsed.behind,
      // `merge` / `rebase` / ... while an operation is half done, else null.
      state: await operationState(root, settings),
    },
    reason: null,
    detail: '',
    files,
    total: { files: files.length, additions, deletions },
  }
}

/**
 * Parse `git status --porcelain=v2 -z`.
 * @param {string} raw - NUL-separated records.
 * @returns {{ branch: string | null, detached: boolean, oid: string | null, ahead: number, behind: number, files: object[] }} parsed status.
 */
function parseStatus(raw) {
  const records = raw.split('\0')
  const files = []
  let branch = null
  let detached = false
  let oid = null
  let ahead = 0
  let behind = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === '') continue
    if (record.startsWith('# ')) {
      const line = record.slice(2)
      if (line.startsWith('branch.oid ')) oid = line.slice('branch.oid '.length).trim()
      else if (line.startsWith('branch.head ')) {
        const value = line.slice('branch.head '.length).trim()
        if (value === '(detached)') detached = true
        else branch = value
      } else if (line.startsWith('branch.ab ')) {
        const match = /^\+(\d+) -(\d+)$/.exec(line.slice('branch.ab '.length).trim())
        if (match !== null) { ahead = Number(match[1]); behind = Number(match[2]) }
      }
      continue
    }
    const kind = record[0]
    if (kind === '1') {
      const parts = record.split(' ')
      files.push(entryOf(parts.slice(8).join(' '), null, parts[1] ?? '..'))
    } else if (kind === '2') {
      const parts = record.split(' ')
      const path = parts.slice(9).join(' ')
      const origPath = records[index + 1] ?? null
      index += 1
      files.push(entryOf(path, origPath, parts[1] ?? '..'))
    } else if (kind === 'u') {
      const parts = record.split(' ')
      files.push(entryOf(parts.slice(10).join(' '), null, parts[1] ?? 'UU'))
    } else if (kind === '?') {
      files.push(entryOf(record.slice(2), null, '??'))
    }
  }
  return { branch, detached, oid, ahead, behind, files }
}

/**
 * Build one file entry from a porcelain XY pair.
 * @param {string} path - current path.
 * @param {string | null} origPath - source path of a rename/copy.
 * @param {string} xy - index/worktree status letters.
 * @returns {object} file entry.
 */
function entryOf(path, origPath, xy) {
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  let kind = 'modified'
  if (xy === '??') kind = 'untracked'
  else if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) kind = 'conflict'
  else if (index === 'R' || worktree === 'R') kind = 'renamed'
  else if (index === 'A' || worktree === 'A') kind = 'added'
  else if (index === 'D' || worktree === 'D') kind = 'deleted'
  return { path, origPath, index, worktree, kind, additions: 0, deletions: 0, binary: false, touched: false }
}

/**
 * Parse `git diff --numstat -z` into a path map.
 * @param {string} raw - NUL-separated records.
 * @returns {Map<string, { additions: number, deletions: number, binary: boolean }>} per-path stats.
 */
function parseNumstat(raw) {
  const map = new Map()
  const tokens = raw.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    const parts = token.split('\t')
    if (parts.length < 3) continue
    const binary = parts[0] === '-' || parts[1] === '-'
    let path = parts.slice(2).join('\t')
    if (path === '') {
      index += 1
      index += 1
      path = tokens[index] ?? ''
    }
    if (path === '') continue
    map.set(path, {
      additions: binary ? 0 : Number(parts[0]) || 0,
      deletions: binary ? 0 : Number(parts[1]) || 0,
      binary,
    })
  }
  return map
}

/**
 * Count the lines of an untracked file for its addition stat.
 * @param {string} root - repository root.
 * @param {string} path - repository-relative path.
 * @returns {Promise<number>} line count, capped by read size.
 */
async function countFileLines(root, path) {
  try {
    const info = await stat(resolve(root, path))
    if (info.size > 256 * 1024) return 0
    const text = await readFile(resolve(root, path), 'utf8')
    if (text.includes('\0')) return 0
    if (text === '') return 0
    const lines = text.split('\n').length
    return text.endsWith('\n') ? lines - 1 : lines
  } catch {
    return 0
  }
}

/**
 * Map session-touched raw paths onto repository-relative paths.
 * @param {string} root - repository root.
 * @param {unknown} sessionId - Session identity.
 * @param {Map<string, Set<string>>} touchedBySession - stored raw paths.
 * @returns {Promise<Set<string>>} repository-relative touched paths.
 */
async function touchedRelative(root, sessionId, touchedBySession) {
  const out = new Set()
  if (typeof sessionId !== 'string') return out
  const raw = touchedBySession.get(sessionId)
  if (raw === undefined) return out
  let canonicalRoot
  for (const entry of raw) {
    const abs = isAbsolute(entry) ? resolve(entry) : resolve(root, entry)
    let rel = relative(root, abs)
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      // A symlinked root (`/tmp` -> `/private/tmp`) makes the lexical compare fail; retry canonically.
      try {
        canonicalRoot ??= await realpath(root)
        rel = relative(canonicalRoot, await realpath(abs))
      } catch {
        continue
      }
      if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
    }
    out.add(rel.split(sep).join('/'))
  }
  return out
}

/**
 * Extract written paths from one tool call's arguments.
 * @param {string} name - tool name.
 * @param {unknown} args - validated call arguments.
 * @returns {string[]} written paths as supplied.
 */
function touchedPathsOf(name, args) {
  if (!WRITE_TOOLS.has(name) || args === null || typeof args !== 'object') return []
  if (name === 'write' || name === 'edit') {
    return typeof args.file_path === 'string' ? [args.file_path] : []
  }
  if (name === 'str_replace_editor') {
    if (args.command === 'view') return []
    return typeof args.path === 'string' ? [args.path] : []
  }
  if (name === 'apply_patch') {
    const patch = typeof args.input === 'string' ? args.input : ''
    const paths = []
    for (const line of patch.split('\n')) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
        ?? /^\*\*\* Move to: (.+)$/.exec(line)
      if (match !== null) paths.push(match[1].trim())
    }
    return paths
  }
  return []
}

/* ============================== diff ============================== */

/**
 * Render one file's diff against HEAD.
 * @param {unknown} cwd - project directory.
 * @param {unknown} path - repository-relative file path.
 * @param {unknown} origPath - rename source, when known.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} diff payload.
 */
/** Rows one preview may return before it reports truncation. */
const MAX_PREVIEW_ROWS = 6000

/** Files larger than this are not read for a preview. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024

/**
 * Build the side-by-side preview of one file: a two-column diff for a tracked
 * file, or the whole content (all lines added) for an untracked one.
 * @param {unknown} cwd - project directory.
 * @param {unknown} path - repository-relative path.
 * @param {unknown} origPath - rename source, when known.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} preview payload with aligned rows.
 */
/**
 * Read one whole file from the working tree so the panel can edit it.
 * @param {unknown} cwd - project directory.
 * @param {unknown} path - repository-relative path.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} the file's text.
 */
async function readTextOf(cwd, path, settings) {
  const root = await repoRoot(cwd, settings)
  const relativePath = safeRelative(root, path)
  const absolute = resolve(root, relativePath)
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new ApiError('not-found', `cannot read ${relativePath}: it is gone`, 404)
  }
  if (!info.isFile()) throw new ApiError('not-a-file', `${relativePath} is not a regular file`, 400)
  if (info.size > MAX_PREVIEW_BYTES) throw new ApiError('too-large', `${relativePath} is too large to edit here`, 413)
  const buffer = await readFile(absolute)
  if (buffer.subarray(0, 8192).includes(0)) throw new ApiError('binary', `${relativePath} is binary`, 415)
  return { path: relativePath, content: buffer.toString('utf8') }
}

/**
 * Replace one file's text in the working tree.
 * @param {unknown} cwd - project directory.
 * @param {unknown} path - repository-relative path.
 * @param {unknown} content - full new text.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} the written path.
 */
async function writeTextOf(cwd, path, content, settings) {
  if (typeof content !== 'string') throw new ApiError('bad-content', 'content must be a string', 400)
  const root = await repoRoot(cwd, settings)
  const relativePath = safeRelative(root, path)
  const absolute = resolve(root, relativePath)
  try {
    const info = await stat(absolute)
    if (info.isDirectory()) throw new ApiError('not-a-file', `${relativePath} is a directory`, 400)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('not-found', `cannot save ${relativePath}: the file is gone`, 404)
  }
  await writeFile(absolute, content, 'utf8')
  return { path: relativePath, bytes: Buffer.byteLength(content, 'utf8') }
}

async function previewOf(cwd, path, origPath, settings) {
  const root = await repoRoot(cwd, settings)
  const relativePath = safeRelative(root, path)
  const source = origPath === undefined || origPath === null ? null : safeRelative(root, origPath)
  const tracked = await runGit(root, ['ls-files', '--error-unmatch', '--', relativePath], undefined, settings)
  const hasHead = (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, settings)).code === 0
  if (tracked.code !== 0) {
    // A file deleted from the working tree leaves the index, but HEAD still
    // knows it: its preview is the HEAD content with every line removed.
    const inHead = hasHead
      && (await runGit(root, ['cat-file', '-e', `HEAD:${relativePath}`], undefined, settings)).code === 0
    if (!inHead) return await untrackedPreview(root, relativePath)
  }
  const pathspec = ['--', relativePath]
  if (source !== null) pathspec.push(source)
  let text
  let truncated = false
  if (hasHead) {
    const result = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', 'HEAD', ...pathspec], { timeoutMs: GIT_TIMEOUT_MS }, settings)
    if (result.code !== 0) throw new ApiError('git-failed', result.stderr || 'git diff failed', 500)
    text = result.stdout
    truncated = result.truncated
  } else {
    const cached = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', '--cached', ...pathspec], undefined, settings)
    const worktree = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', ...pathspec], undefined, settings)
    if (cached.code !== 0) throw new ApiError('git-failed', cached.stderr || 'git diff failed', 500)
    if (worktree.code !== 0) throw new ApiError('git-failed', worktree.stderr || 'git diff failed', 500)
    text = [cached.stdout, worktree.stdout].filter(part => part !== '').join('\n')
    truncated = cached.truncated || worktree.truncated
  }
  // Name the baseline the left column shows, so the two panes can be labelled
  // with the versions a reviewer is comparing.
  let oldRef = null
  if (hasHead) {
    const short = await runGit(root, ['rev-parse', '--short', 'HEAD'], undefined, settings)
    if (short.code === 0) oldRef = short.stdout.trim()
  }
  if (/^Binary files .* differ$/m.test(text)) {
    return { path: relativePath, kind: 'binary', untracked: false, oldRef, rows: [], additions: 0, deletions: 0, truncated: false }
  }
  const parsed = parseUnifiedRows(text)
  return {
    path: relativePath,
    kind: 'text',
    untracked: false,
    oldRef,
    rows: parsed.rows.slice(0, MAX_PREVIEW_ROWS),
    additions: parsed.additions,
    deletions: parsed.deletions,
    truncated: truncated || parsed.rows.length > MAX_PREVIEW_ROWS,
  }
}

/**
 * Read an untracked file as a preview whose every line counts as added.
 * @param {string} root - repository root.
 * @param {string} path - repository-relative path.
 * @returns {Promise<object>} preview payload.
 */
async function untrackedPreview(root, path) {
  const absolute = resolve(root, path)
  let info
  try {
    info = await stat(absolute)
  } catch {
    // Raced with a delete: nothing left to show.
    return { path, kind: 'text', untracked: true, oldRef: null, rows: [], additions: 0, deletions: 0, truncated: false }
  }
  if (info.size > MAX_PREVIEW_BYTES) {
    return { path, kind: 'tooLarge', untracked: true, oldRef: null, rows: [], additions: 0, deletions: 0, truncated: true }
  }
  const buffer = await readFile(absolute)
  if (buffer.subarray(0, 8192).includes(0)) {
    return { path, kind: 'binary', untracked: true, oldRef: null, rows: [], additions: 0, deletions: 0, truncated: false }
  }
  const lines = buffer.toString('utf8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rows = lines.slice(0, MAX_PREVIEW_ROWS).map((line, index) => ({ type: 'add', newNo: index + 1, newText: line }))
  return {
    path,
    kind: 'text',
    untracked: true,
    oldRef: null,
    rows,
    additions: lines.length,
    deletions: 0,
    truncated: lines.length > MAX_PREVIEW_ROWS,
  }
}

/**
 * Turn unified diff text into aligned two-column rows.
 *
 * A run of removed lines followed by a run of added lines is what a modified
 * block looks like; pairing them index by index is what makes the two columns
 * line up the way an IDE shows it.
 * @param {string} text - `git diff` output.
 * @returns {{ rows: Array<object>, additions: number, deletions: number }} aligned rows and counts.
 */
function parseUnifiedRows(text) {
  const rows = []
  const lines = text.split('\n')
  let oldNo = 0
  let newNo = 0
  let additions = 0
  let deletions = 0
  let inHunk = false
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === '') { index += 1; continue }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk !== null) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      rows.push({ type: 'hunk', text: line })
      index += 1
      continue
    }
    if (!inHunk && /^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity index|rename |old mode|new mode|copy )/.test(line)) {
      if (line.startsWith('diff --git')) rows.push({ type: 'meta', text: line })
      index += 1
      continue
    }
    if (line.startsWith('\\')) { index += 1; continue }
    if (line.startsWith(' ')) {
      rows.push({ type: 'ctx', oldNo, newNo, oldText: line.slice(1), newText: line.slice(1) })
      oldNo += 1
      newNo += 1
      index += 1
      continue
    }
    const removed = []
    while (index < lines.length && lines[index].startsWith('-') && !lines[index].startsWith('---')) {
      removed.push(lines[index].slice(1))
      index += 1
    }
    const added = []
    while (index < lines.length && lines[index].startsWith('+') && !lines[index].startsWith('+++')) {
      added.push(lines[index].slice(1))
      index += 1
    }
    if (removed.length === 0 && added.length === 0) { index += 1; continue }
    const pairs = Math.max(removed.length, added.length)
    for (let cursor = 0; cursor < pairs; cursor += 1) {
      const oldText = cursor < removed.length ? removed[cursor] : undefined
      const newText = cursor < added.length ? added[cursor] : undefined
      if (oldText !== undefined && newText !== undefined) {
        rows.push({ type: 'mod', oldNo, newNo, oldText, newText })
        oldNo += 1
        newNo += 1
        additions += 1
        deletions += 1
      } else if (oldText !== undefined) {
        rows.push({ type: 'del', oldNo, oldText })
        oldNo += 1
        deletions += 1
      } else {
        rows.push({ type: 'add', newNo, newText })
        newNo += 1
        additions += 1
      }
    }
  }
  return { rows, additions, deletions }
}

async function diffOf(cwd, path, origPath, settings) {
  const root = await repoRoot(cwd, settings)
  const relativePath = safeRelative(root, path)
  const source = origPath === undefined || origPath === null ? null : safeRelative(root, origPath)
  const tracked = await runGit(root, ['ls-files', '--error-unmatch', '--', relativePath], undefined, settings)
  if (tracked.code !== 0) {
    return await untrackedDiff(root, relativePath, settings)
  }
  const hasHead = (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, settings)).code === 0
  const pathspec = ['--', relativePath]
  if (source !== null) pathspec.push(source)
  let text
  let truncated = false
  if (hasHead) {
    const result = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', 'HEAD', ...pathspec], { timeoutMs: GIT_TIMEOUT_MS }, settings)
    if (result.code !== 0) throw new ApiError('git-failed', result.stderr || 'git diff failed', 500)
    text = result.stdout
    truncated = result.truncated
  } else {
    /*
     * An unborn HEAD has no commit to diff against, so combine the index and
     * the working tree: `git diff` alone hides staged additions.
     */
    const cached = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', '--cached', ...pathspec], undefined, settings)
    const worktree = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '-U100000', ...pathspec], undefined, settings)
    if (cached.code !== 0) throw new ApiError('git-failed', cached.stderr || 'git diff failed', 500)
    if (worktree.code !== 0) throw new ApiError('git-failed', worktree.stderr || 'git diff failed', 500)
    text = [cached.stdout, worktree.stdout].filter(part => part !== '').join('\n')
    truncated = cached.truncated || worktree.truncated
  }
  const binary = /^Binary files .* differ$/m.test(text)
  const clipped = clipDiff(text, settings.maxDiffChars)
  return {
    path: relativePath,
    diff: clipped.text,
    truncated: truncated || clipped.truncated,
    binary,
    untracked: false,
  }
}

/**
 * Synthesize an all-added diff for an untracked file.
 * @param {string} root - repository root.
 * @param {string} path - repository-relative path.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} diff payload.
 */
async function untrackedDiff(root, path, settings) {
  const absolute = resolve(root, path)
  const info = await stat(absolute)
  if (info.size > 2 * 1024 * 1024) {
    return { path, diff: '', truncated: true, binary: false, untracked: true, tooLarge: true }
  }
  const buffer = await readFile(absolute)
  if (buffer.subarray(0, 8192).includes(0)) {
    return { path, diff: `Binary file ${path}`, truncated: false, binary: true, untracked: true }
  }
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const clipped = clipDiff(lines.map(line => '+' + line).join('\n'), settings.maxDiffChars)
  return {
    path,
    diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${clipped.text}`,
    truncated: clipped.truncated,
    binary: false,
    untracked: true,
  }
}

/**
 * Clip a diff to the configured budget.
 * @param {string} text - full text.
 * @param {number} maxChars - character budget.
 * @returns {{ text: string, truncated: boolean }} clipped text.
 */
function clipDiff(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n… (diff truncated)`, truncated: true }
}

/* ============================== commit ============================== */

/**
 * Stage and commit the selected paths (all changed paths when omitted).
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity for the post-commit status.
 * @param {unknown} message - commit message.
 * @param {unknown} paths - repository-relative selection.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} commit payload with a fresh status.
 */
async function commitOf(cwd, sessionId, message, paths, settings, touchedBySession, push = false) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ApiError('empty-message', 'a commit message is required')
  }
  const trimmed = message.trim()
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ApiError('message-too-long', `commit message exceeds ${MAX_MESSAGE_CHARS} characters`)
  }
  const root = await repoRoot(cwd, settings)
  const statusResult = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], undefined, settings)
  if (statusResult.code !== 0) {
    throw new ApiError('git-failed', statusResult.stderr || 'git status failed', 500)
  }
  const changed = parseStatus(statusResult.stdout).files
  const allowed = new Map()
  for (const entry of changed) {
    allowed.set(entry.path, entry)
    if (entry.origPath !== null) allowed.set(entry.origPath, entry)
  }
  /*
   * Two path lists: `addPaths` holds paths that exist in the working tree or
   * the index, because `git add` cannot name the vanished source of a staged
   * rename; `commitPaths` also carries that source so the rename commits as a
   * whole instead of leaving its deletion staged.
   */
  const addPaths = []
  const commitPaths = []
  const add = entry => {
    if (!addPaths.includes(entry.path)) addPaths.push(entry.path)
    if (!commitPaths.includes(entry.path)) commitPaths.push(entry.path)
    if (entry.origPath !== null && !commitPaths.includes(entry.origPath)) commitPaths.push(entry.origPath)
  }
  if (Array.isArray(paths) && paths.length > 0) {
    for (const raw of paths) {
      const relativePath = safeRelative(root, raw)
      const entry = allowed.get(relativePath)
      if (entry === undefined) {
        throw new ApiError('stale-selection', `"${relativePath}" has no uncommitted change to commit`)
      }
      add(entry)
    }
  } else {
    for (const entry of changed) add(entry)
  }
  if (addPaths.length === 0) {
    throw new ApiError('nothing-to-commit', 'there are no uncommitted changes to commit')
  }
  const conflicts = [...new Set([...addPaths, ...commitPaths])]
    .map(path => changed.find(entry => entry.path === path))
    .filter(entry => entry !== undefined && entry.kind === 'conflict')
    .map(entry => entry.path)
  if (conflicts.length > 0) {
    throw new ApiError(
      'unresolved-conflict',
      `resolve these conflicts before committing: ${[...new Set(conflicts)].join(', ')}`,
    )
  }
  const addResult = await runGit(root, ['add', '-A', '--', ...addPaths], { timeoutMs: 120_000 }, settings)
  if (addResult.code !== 0) {
    throw new ApiError('git-failed', addResult.stderr || 'git add failed', 500)
  }
  const commitResult = await runGit(
    root,
    ['commit', '-F', '-', '--cleanup=whitespace', '--', ...commitPaths],
    { input: trimmed + '\n', timeoutMs: 180_000 },
    settings,
  )
  if (commitResult.code !== 0) {
    throw new ApiError('commit-failed', commitResult.stderr || commitResult.stdout || 'git commit failed')
  }
  const logResult = await runGit(root, ['log', '-1', '--pretty=%h%x00%s'], undefined, settings)
  const [hash, subject] = logResult.stdout.split('\0')
  let status = null
  try {
    status = await statusOf(root, sessionId, settings, touchedBySession)
  } catch {
    status = null
  }
  const pushResult = push ? await pushOf(root, settings) : null
  return {
    commit: {
      hash: (hash ?? '').trim(),
      subject: (subject ?? '').trim(),
      files: commitPaths,
    },
    push: pushResult,
    status,
  }
}

/**
 * Push the current branch to its configured upstream.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @param {{ force?: boolean, remote?: string, setUpstream?: boolean }} [options] -
 *   `force` asks for `--force-with-lease`, `setUpstream: false` refuses a branch
 *   that has no upstream yet instead of creating one, and `remote` names the
 *   remote to create it on.
 * @returns {Promise<object>} push outcome, with git's own output when it ran.
 */
async function pushOf(root, settings, options = {}) {
  const branch = await currentBranch(root, settings)
  if (await upstreamOf(root, branch, settings) === '') {
    if (options.setUpstream === false) {
      return {
        ok: false,
        code: 'no-upstream',
        error: 'the current branch has no upstream; run git push -u <remote> <branch> once, then retry',
      }
    }
    if (branch === '') {
      return { ok: false, code: 'detached', error: 'HEAD is detached, so there is no branch to push' }
    }
    const remote = await pushRemoteOf(root, settings, options.remote)
    if (remote === null) {
      return { ok: false, code: 'no-remote', error: 'this repository has no remote to push to' }
    }
    const created = await runGit(root, ['push', '--set-upstream', remote, branch], { timeoutMs: 180_000 }, settings)
    return created.code === 0
      ? { ok: true, setUpstream: true, output: textOf(created) }
      : { ok: false, code: 'push-failed', error: textOf(created) || 'git push failed' }
  }
  const args = ['push']
  if (options.force === true) args.push('--force-with-lease')
  const result = await runGit(root, args, { timeoutMs: 180_000 }, settings)
  if (result.code !== 0) {
    return { ok: false, code: 'push-failed', error: textOf(result) || 'git push failed' }
  }
  return { ok: true, output: textOf(result) }
}

/**
 * The remote a fresh upstream should live on.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @param {string} [requested] - a remote the caller named.
 * @returns {Promise<string | null>} remote name, or null when there is none.
 */
async function pushRemoteOf(root, settings, requested) {
  const named = typeof requested === 'string' ? requested.trim() : ''
  if (named !== '') return named
  const listed = (await runGit(root, ['remote'], undefined, settings)).stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (listed.includes('origin')) return 'origin'
  return listed.length > 0 ? listed[0] : null
}

/**
 * Discard the working-tree and index changes of the selected paths.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity for the fresh status.
 * @param {unknown} paths - repository-relative selection.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} rollback payload with a fresh status.
 */
async function rollbackOf(cwd, sessionId, paths, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ApiError('bad-request', 'paths are required')
  }
  const statusResult = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], undefined, settings)
  if (statusResult.code !== 0) {
    throw new ApiError('git-failed', statusResult.stderr || 'git status failed', 500)
  }
  const changed = parseStatus(statusResult.stdout).files
  const allowed = new Map()
  for (const entry of changed) {
    allowed.set(entry.path, entry)
    if (entry.origPath !== null) allowed.set(entry.origPath, entry)
  }
  const entries = []
  for (const raw of paths) {
    const relativePath = safeRelative(root, raw)
    const entry = allowed.get(relativePath)
    if (entry === undefined) {
      throw new ApiError('stale-selection', `"${relativePath}" has no uncommitted change to discard`)
    }
    if (!entries.includes(entry)) entries.push(entry)
  }
  const conflicts = entries.filter(entry => entry.kind === 'conflict').map(entry => entry.path)
  if (conflicts.length > 0) {
    throw new ApiError('unresolved-conflict', `resolve these conflicts with git first: ${conflicts.join(', ')}`)
  }
  const hasHead = (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, settings)).code === 0
  const failures = []
  for (const entry of entries) {
    if (entry.kind === 'untracked') {
      const result = await runGit(root, ['clean', '-f', '--', entry.path], undefined, settings)
      if (result.code !== 0) failures.push(`${entry.path}: ${result.stderr || 'git clean failed'}`)
      continue
    }
    if (entry.index === 'A') {
      const result = await runGit(root, ['rm', '-f', '--', entry.path], undefined, settings)
      if (result.code !== 0) failures.push(`${entry.path}: ${result.stderr || 'git rm failed'}`)
      continue
    }
    if (!hasHead) {
      failures.push(`${entry.path}: the repository has no commit to restore from yet`)
      continue
    }
    const targets = [entry.path]
    if (entry.origPath !== null) targets.push(entry.origPath)
    const result = await runGit(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...targets], undefined, settings)
    if (result.code !== 0) failures.push(`${entry.path}: ${result.stderr || 'git restore failed'}`)
  }
  if (failures.length > 0) {
    throw new ApiError('rollback-failed', failures.join('\n'), 500)
  }
  const status = await statusOf(root, sessionId, settings, touchedBySession)
  return { rolledBack: entries.map(entry => entry.path), status }
}

/* ============================== branch & sync ============================== */

/** `for-each-ref` layout for a local branch: name, upstream, track, subject. */
const LOCAL_REF_FORMAT = '%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(contents:subject)'
/** `for-each-ref` layout for a remote branch or a tag: name, oid, subject. */
const PLAIN_REF_FORMAT = '%(refname:short)\t%(objectname:short)\t%(contents:subject)'

/**
 * Run one git command and turn a non-zero exit into an API error.
 * @param {string} root - repository root.
 * @param {string[]} args - git arguments.
 * @param {{ input?: string, timeoutMs?: number }} [options] - stdin and deadline.
 * @param {object} settings - normalized row configuration.
 * @param {string} failCode - error code when nothing else is in progress.
 * @returns {Promise<{ code: number | string, stdout: string, stderr: string, truncated: boolean }>} outcome, code 0.
 */
async function mustGit(root, args, options, settings, failCode) {
  const result = await runGit(root, args, options, settings)
  if (result.code !== 0) {
    const state = await operationState(root, settings)
    throw new ApiError(state === null ? failCode : `${state}-interrupted`, textOf(result) || 'git failed', 500)
  }
  return result
}

/**
 * Run one sync operation and answer with its output plus a fresh status.
 * @param {string} root - repository root.
 * @param {string[]} args - git arguments.
 * @param {{ input?: string, timeoutMs?: number }} [options] - stdin and deadline.
 * @param {object} settings - normalized row configuration.
 * @param {string} sessionId - Session identity for the fresh status.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @param {string} failCode - error code for a plain failure.
 * @returns {Promise<{ output: string, status: object }>} operation payload.
 */
async function syncOp(root, args, options, settings, sessionId, touchedBySession, failCode) {
  const result = await mustGit(root, args, options, settings, failCode)
  const status = await statusOf(root, sessionId, settings, touchedBySession)
  return { output: textOf(result), status }
}

/**
 * Join everything git printed, on either stream.
 * @param {{ stdout: string, stderr: string }} result - one git outcome.
 * @returns {string} trimmed output.
 */
function textOf(result) {
  return [result.stdout, result.stderr]
    .map(part => part.trim())
    .filter(part => part !== '')
    .join('\n')
}

/**
 * Validate one revision, branch, tag or remote name from the panel.
 *
 * Names reach git as their own argv entry, so nothing here is about quoting;
 * it only keeps an empty value or something git would read as an option out.
 * @param {unknown} value - caller-supplied name.
 * @param {string} label - what to call it in the error.
 * @returns {string} the trimmed name.
 */
function revName(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new ApiError('bad-request', `${label} is required`)
  if (text.length > 200 || /[\s\0]/.test(text) || text.startsWith('-')) {
    throw new ApiError('bad-ref', `${label} is not usable: ${text}`)
  }
  return text
}

/**
 * The branch that is checked out now.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<string>} short branch name, empty for a detached HEAD.
 */
async function currentBranch(root, settings) {
  const result = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], undefined, settings)
  return result.code === 0 ? result.stdout.trim() : ''
}

/**
 * The upstream a branch tracks, read from the ref table.
 *
 * `rev-parse @u` is the shorter spelling but Apple's git reads a bare `@u` as
 * a path, so the field is asked for directly instead.
 * @param {string} root - repository root.
 * @param {string} branch - local branch name.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<string>} `origin/main`, or empty when nothing is tracked.
 */
async function upstreamOf(root, branch, settings) {
  if (branch === '') return ''
  const result = await runGit(
    root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], undefined, settings,
  )
  return result.code === 0 ? result.stdout.trim() : ''
}

/**
 * Whether a merge, rebase, cherry-pick, revert or bisect is half done.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<string | null>} the operation name, or null when idle.
 */
async function operationState(root, settings) {
  const found = await runGit(root, ['rev-parse', '--absolute-git-dir'], undefined, settings)
  if (found.code !== 0) return null
  const gitDir = found.stdout.trim()
  /**
   * @param {string} name - entry under the git directory.
   * @returns {Promise<boolean>} whether it exists.
   */
  const exists = async (name) => {
    try {
      await stat(join(gitDir, name))
      return true
    } catch {
      return false
    }
  }
  if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase'
  if (await exists('MERGE_HEAD')) return 'merge'
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (await exists('REVERT_HEAD')) return 'revert'
  if (await exists('BISECT_LOG')) return 'bisect'
  return null
}

/**
 * Whether the working tree or the index holds anything at all.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<boolean>} whether there are uncommitted changes.
 */
async function isDirty(root, settings) {
  const result = await runGit(root, ['status', '--porcelain', '--untracked-files=normal'], undefined, settings)
  return result.code === 0 && result.stdout.trim() !== ''
}

/**
 * Read the `ahead N, behind M` bracket git puts in `%(upstream:track)`.
 * @param {string} track - the raw field, brackets included, or empty.
 * @returns {{ ahead: number, behind: number, gone: boolean }} the counts.
 */
function parseTrack(track) {
  const out = { ahead: 0, behind: 0, gone: false }
  const body = (track ?? '').trim().replace(/^\[/, '').replace(/\]$/, '')
  if (body === 'gone') {
    out.gone = true
    return out
  }
  for (const part of body.split(',')) {
    const match = /^(ahead|behind)\s+(\d+)$/.exec(part.trim())
    if (match === null) continue
    if (match[1] === 'ahead') out.ahead = Number(match[2])
    else out.behind = Number(match[2])
  }
  return out
}

/**
 * Split one `for-each-ref` answer into rows.
 * @param {string} raw - tab separated lines.
 * @param {number} head - the fields before the subject, which may hold tabs.
 * @returns {Array<string[]>} the field lists.
 */
function refRows(raw, head) {
  const rows = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts[0] === undefined || parts[0] === '') continue
    rows.push([...parts.slice(0, head), parts.slice(head).join('\t')])
  }
  return rows
}

/**
 * List everything the branch popup needs.
 * @param {unknown} cwd - project directory.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} current branch, local, remote and tag rows.
 */
async function branchesOf(cwd, settings) {
  const root = await repoRoot(cwd, settings)
  const current = await currentBranch(root, settings)
  const upstream = await upstreamOf(root, current, settings)
  const local = refRows(
    (await mustGit(root, ['for-each-ref', '--sort=-committerdate', `--format=${LOCAL_REF_FORMAT}`, 'refs/heads'], undefined, settings, 'git-failed')).stdout,
    3,
  ).map(([name, upstream, track, subject]) => ({
    name,
    upstream,
    ...parseTrack(track),
    subject: subject ?? '',
    current: name === current,
  }))
  const remote = refRows(
    (await mustGit(root, ['for-each-ref', '--sort=-committerdate', `--format=${PLAIN_REF_FORMAT}`, 'refs/remotes'], undefined, settings, 'git-failed')).stdout,
    2,
  )
    // `origin/HEAD` is a pointer, not a branch a person can check out.
    .filter(([name]) => !name.endsWith('/HEAD'))
    .map(([name, oid, subject]) => ({
      name,
      remote: name.split('/')[0],
      branch: name.split('/').slice(1).join('/'),
      oid,
      subject: subject ?? '',
      current: name === upstream,
    }))
  const tags = refRows(
    (await mustGit(root, ['for-each-ref', '--sort=-creatordate', `--format=${PLAIN_REF_FORMAT}`, 'refs/tags'], undefined, settings, 'git-failed')).stdout,
    2,
  ).map(([name, oid, subject]) => ({ name, oid, subject: subject ?? '' }))
  const remotes = (await runGit(root, ['remote'], undefined, settings)).stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const stash = (await runGit(root, ['stash', 'list'], undefined, settings)).stdout
    .split('\n')
    .filter(line => line.trim() !== '').length
  return {
    root,
    current,
    detached: current === '',
    upstream,
    state: await operationState(root, settings),
    dirty: await isDirty(root, settings),
    remotes,
    stash,
    local,
    remote,
    tags,
  }
}

/**
 * `git fetch`, across every remote or just the named one.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {unknown} remote - one remote name, or nothing for all of them.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function fetchOf(cwd, sessionId, remote, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const args = typeof remote === 'string' && remote.trim() !== ''
    ? ['fetch', '--prune', revName(remote, 'remote')]
    : ['fetch', '--all', '--prune']
  return syncOp(root, args, { timeoutMs: 180_000 }, settings, sessionId, touchedBySession, 'fetch-failed')
}

/**
 * `git pull`, the way Update Project does it: merge by default, rebase on request.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {unknown} strategy - 'merge' | 'rebase' | 'ff-only'.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function pullOf(cwd, sessionId, strategy, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const mode = strategy === 'rebase' ? '--rebase' : strategy === 'ff-only' ? '--ff-only' : '--no-rebase'
  return syncOp(root, ['pull', mode], { timeoutMs: 300_000 }, settings, sessionId, touchedBySession, 'pull-failed')
}

/**
 * Push the current branch, creating its upstream the first time.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `force` and `remote`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function pushNowOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const outcome = await pushOf(root, settings, {
    force: payload?.force === true,
    remote: typeof payload?.remote === 'string' ? payload.remote.trim() : '',
  })
  if (outcome.ok !== true) throw new ApiError(outcome.code, outcome.error, 500)
  const status = await statusOf(root, sessionId, settings, touchedBySession)
  return { output: outcome.output ?? '', setUpstream: outcome.setUpstream === true, status }
}

/**
 * Check out a branch, tag or revision, keeping uncommitted work when asked.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {unknown} rev - the target revision.
 * @param {unknown} smart - whether to stash and restore around the switch.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output, stash outcome, and a fresh status.
 */
async function checkoutOf(cwd, sessionId, rev, smart, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const target = revName(rev, 'branch or revision')
  let stashed = false
  if (await isDirty(root, settings)) {
    if (smart !== true) {
      throw new ApiError(
        'local-changes',
        'the working tree has uncommitted changes; commit them, stash them, or use smart checkout',
        409,
      )
    }
    await mustGit(
      root,
      ['stash', 'push', '--include-untracked', '-m', `dsh-git-commit: checkout ${target}`],
      undefined, settings, 'stash-failed',
    )
    stashed = true
  }
  const result = await runGit(root, ['checkout', target], { timeoutMs: 120_000 }, settings)
  if (result.code !== 0) {
    if (stashed) await runGit(root, ['stash', 'pop'], undefined, settings)
    const state = await operationState(root, settings)
    throw new ApiError(state === null ? 'checkout-failed' : `${state}-interrupted`, textOf(result) || 'git checkout failed', 500)
  }
  // A conflicted pop leaves the work safely inside the stash; say so, do not fail.
  let stashKept = false
  if (stashed) {
    const pop = await runGit(root, ['stash', 'pop'], { timeoutMs: 120_000 }, settings)
    stashKept = pop.code !== 0
  }
  const status = await statusOf(root, sessionId, settings, touchedBySession)
  return { output: textOf(result), stashed, stashKept, status }
}

/**
 * Create, delete or rename a branch.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `action`, `name`, `start`, `newName`, `checkout`, `force`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function branchOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const name = revName(payload?.name, 'branch name')
  const action = payload?.action
  if (action === 'create') {
    const start = typeof payload.start === 'string' && payload.start.trim() !== ''
      ? revName(payload.start, 'start point')
      : null
    const args = payload.checkout === true ? ['checkout', '-b', name] : ['branch', name]
    if (start !== null) args.push(start)
    return syncOp(root, args, { timeoutMs: 120_000 }, settings, sessionId, touchedBySession, 'branch-failed')
  }
  if (action === 'delete') {
    return syncOp(
      root, ['branch', payload.force === true ? '-D' : '-d', name], { timeoutMs: 60_000 },
      settings, sessionId, touchedBySession, 'branch-failed',
    )
  }
  if (action === 'rename') {
    return syncOp(
      root, ['branch', '-m', name, revName(payload.newName, 'new branch name')], { timeoutMs: 60_000 },
      settings, sessionId, touchedBySession, 'branch-failed',
    )
  }
  throw new ApiError('bad-request', `unknown branch action "${String(action)}"`)
}

/**
 * Merge a branch into the current one, or finish / back out of a merge.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `ref`, `squash`, `action`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function mergeOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  if (payload?.action === 'abort') {
    return syncOp(root, ['merge', '--abort'], undefined, settings, sessionId, touchedBySession, 'merge-failed')
  }
  if (payload?.action === 'continue') {
    return syncOp(root, ['merge', '--no-edit', '--commit'], undefined, settings, sessionId, touchedBySession, 'merge-failed')
  }
  const args = ['merge', '--no-edit']
  if (payload?.squash === true) args.push('--squash')
  args.push(revName(payload?.ref, 'branch'))
  return syncOp(root, args, { timeoutMs: 180_000 }, settings, sessionId, touchedBySession, 'merge-failed')
}

/**
 * Rebase the current branch onto another, or continue / abort one in progress.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `onto`, `action`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function rebaseOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  if (payload?.action === 'abort') {
    return syncOp(root, ['rebase', '--abort'], undefined, settings, sessionId, touchedBySession, 'rebase-failed')
  }
  if (payload?.action === 'continue') {
    return syncOp(root, ['rebase', '--continue'], { timeoutMs: 120_000 }, settings, sessionId, touchedBySession, 'rebase-failed')
  }
  return syncOp(
    root, ['rebase', revName(payload?.onto, 'branch')], { timeoutMs: 300_000 },
    settings, sessionId, touchedBySession, 'rebase-failed',
  )
}

/**
 * Count the commits in one `A..B` range.
 * @param {string} root - repository root.
 * @param {string} range - the revision range.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<number>} commits in range.
 */
async function countRange(root, range, settings) {
  const result = await runGit(root, ['rev-list', '--count', range], undefined, settings)
  const count = Number.parseInt(result.stdout.trim(), 10)
  return result.code === 0 && Number.isFinite(count) ? count : 0
}

/**
 * Split a `git diff --name-status -z` answer, renames included.
 * @param {string} raw - NUL separated records.
 * @returns {Array<{ status: string, path: string, origPath: string | null }>} one row per path.
 */
function parseNameStatusZ(raw) {
  const records = raw.split('\0')
  const out = []
  let index = 0
  while (index < records.length) {
    const status = records[index]
    if (status === undefined || status === '') break
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const origPath = records[index + 1] ?? ''
      const path = records[index + 2] ?? ''
      index += 3
      if (path !== '') out.push({ status: letter, path, origPath })
      continue
    }
    const path = records[index + 1] ?? ''
    index += 2
    if (path !== '') out.push({ status: letter, path, origPath: null })
  }
  return out
}

/**
 * The commits in one `A..B` range, newest first.
 * @param {string} root - repository root.
 * @param {string} range - the revision range.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<Array<{ hash: string, author: string, date: string, subject: string }>>} up to 50 rows.
 */
async function logRange(root, range, settings) {
  const log = (await mustGit(
    root,
    ['log', '--max-count=50', '--date=short', '--pretty=%h\t%an\t%ad\t%s', range],
    undefined, settings, 'git-failed',
  )).stdout
  return log.split('\n').filter(line => line !== '').map(line => {
    const parts = line.split('\t')
    return { hash: parts[0] ?? '', author: parts[1] ?? '', date: parts[2] ?? '', subject: parts.slice(3).join('\t') }
  })
}

/**
 * What two branches hold differently: the Compare With branch dialog.
 * @param {unknown} cwd - project directory.
 * @param {unknown} ref - the branch to compare against.
 * @param {unknown} base - the other side, `HEAD` when omitted.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} counts, changed files, and both sides' commits.
 */
async function compareOf(cwd, ref, base, settings) {
  const root = await repoRoot(cwd, settings)
  const left = typeof base === 'string' && base.trim() !== '' ? revName(base, 'base') : 'HEAD'
  const right = revName(ref, 'branch')
  for (const name of [left, right]) {
    const check = await runGit(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], undefined, settings)
    if (check.code !== 0) throw new ApiError('unknown-revision', `${name} does not resolve to a commit`, 404)
  }
  const ahead = await countRange(root, `${left}..${right}`, settings)
  const behind = await countRange(root, `${right}..${left}`, settings)
  const files = parseNameStatusZ((await mustGit(
    root, ['diff', '--name-status', '-z', left, right], { timeoutMs: 60_000 }, settings, 'git-failed',
  )).stdout)
  return {
    base: left,
    ref: right,
    ahead,
    behind,
    files,
    // The commits each side is holding on its own, so the dialog can say so.
    aheadCommits: await logRange(root, `${left}..${right}`, settings),
    behindCommits: await logRange(root, `${right}..${left}`, settings),
  }
}

/**
 * Point a branch at an upstream, or drop the link.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `branch` and `upstream` (empty to unset).
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function trackingOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const branch = typeof payload?.branch === 'string' && payload.branch.trim() !== ''
    ? revName(payload.branch, 'branch')
    : await currentBranch(root, settings)
  if (branch === '') throw new ApiError('detached', 'HEAD is detached, so no branch can track an upstream')
  const args = payload?.upstream === null || payload?.upstream === '' || payload?.upstream === undefined
    ? ['branch', '--unset-upstream', branch]
    : ['branch', `--set-upstream-to=${revName(payload.upstream, 'upstream')}`, branch]
  return syncOp(root, args, undefined, settings, sessionId, touchedBySession, 'tracking-failed')
}

/**
 * Stash the working tree, or bring the newest stash back.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `action` ('push' | 'pop' | 'apply' | 'drop') and `message`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} output plus a fresh status.
 */
async function stashOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const action = ['pop', 'apply', 'drop'].includes(payload?.action) ? payload.action : 'push'
  const args = action === 'push'
    ? ['stash', 'push', '--include-untracked', '-m',
      typeof payload?.message === 'string' && payload.message.trim() !== ''
        ? payload.message.trim().slice(0, 200)
        : 'dsh-git-commit']
    : ['stash', action]
  return syncOp(root, args, { timeoutMs: 120_000 }, settings, sessionId, touchedBySession, 'stash-failed')
}

/* ============================== remotes ============================== */

/**
 * Validate one remote URL.
 *
 * Spaces are allowed because a local repository path may hold them; what must
 * stay out is anything git could mistake for an option, and control characters.
 * @param {unknown} value - caller-supplied URL.
 * @returns {string} the trimmed URL.
 */
function remoteUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new ApiError('bad-request', 'the remote URL is required')
  if (text.length > 2_000 || /[\0\r\n]/.test(text) || text.startsWith('-')) {
    throw new ApiError('bad-url', `not a usable remote URL: ${text}`)
  }
  return text
}

/**
 * Whether git's own words say the remote is waiting for a person to authenticate.
 *
 * The plugin always runs git with `GIT_TERMINAL_PROMPT=0`, so an https remote
 * with no stored credential fails instead of asking, and the raw line is
 * meaningless to someone who has never seen it.
 * @param {string} text - combined git output.
 * @returns {boolean} true when credentials are what is missing.
 */
function authBlocked(text) {
  return /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|incorrect username or password|invalid credentials/i
    .test(String(text))
}

/**
 * The stdin record `git credential approve` expects for one remote URL.
 *
 * The secret is written straight to git's stdin and appears nowhere else: not in
 * the returned payload, not in the repository configuration, not in a log line.
 * @param {unknown} url - the remote URL.
 * @param {unknown} username - the account.
 * @param {unknown} password - the password or access token.
 * @returns {string} the record, terminated by the blank line git wants.
 */
function credentialInput(url, username, password) {
  const address = remoteUrl(url)
  let parsed
  try {
    parsed = new URL(address)
  } catch {
    throw new ApiError('bad-request', `${address} is not an http(s) remote URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ApiError('bad-request', 'only http(s) remotes take a username and a token; ssh uses keys')
  }
  const account = typeof username === 'string' ? username.trim() : ''
  const secret = typeof password === 'string' ? password.replace(/[\r\n]/g, '') : ''
  // A newline in the account would forge extra fields into git's record.
  if (account === '' || secret === '' || /[\0\r\n]/.test(account)) {
    throw new ApiError('bad-request', 'a username and a password are both required')
  }
  return `protocol=${parsed.protocol.slice(0, -1)}\nhost=${parsed.host}\nusername=${account}\npassword=${secret}\n\n`
}

/**
 * Ask one remote whether it answers, without touching the repository.
 * @param {string} root - directory to run from.
 * @param {unknown} url - the remote URL.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<{ ok: boolean, needsAuth: boolean, message: string }>} the answer.
 */
async function checkRemote(root, url, settings) {
  const result = await runGit(root, ['ls-remote', '--heads', remoteUrl(url)], { timeoutMs: 30_000 }, settings)
  const message = textOf(result)
  return { ok: result.code === 0, needsAuth: result.code !== 0 && authBlocked(message), message }
}

/**
 * Read the remote table: name, fetch URL, and the push URL when it differs.
 * @param {string} root - repository root.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<Array<{ name: string, url: string, pushUrl: string }>>} one row per remote.
 */
async function remoteRows(root, settings) {
  const names = (await runGit(root, ['remote'], undefined, settings)).stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const rows = []
  for (const name of names) {
    const url = (await runGit(root, ['config', '--get', `remote.${name}.url`], undefined, settings)).stdout.trim()
    const push = (await runGit(root, ['remote', 'get-url', '--push', name], undefined, settings)).stdout.trim()
    rows.push({ name, url, pushUrl: push !== '' && push !== url ? push : '' })
  }
  return rows
}

/**
 * Answer the 管理远程 dialog.
 * @param {unknown} cwd - project directory.
 * @param {object} settings - normalized row configuration.
 * @returns {Promise<object>} the repository root and its remotes.
 */
async function remotesOf(cwd, settings) {
  const root = await repoRoot(cwd, settings)
  return { root, remotes: await remoteRows(root, settings) }
}

/**
 * Add, rename, re-point or remove one remote.
 *
 * A new remote is fetched once so its branches show up in the popup at once;
 * a failing fetch is reported but never undoes the add. When the failure is
 * git refusing to ask for credentials, the answer says so: the dialog can then
 * take a username and a token instead of leaving it for the next push to find.
 * @param {unknown} cwd - project directory.
 * @param {unknown} sessionId - Session identity.
 * @param {object} payload - `action`, `name`, `url`, `newName`, `push`, `username`, `password`.
 * @param {object} settings - normalized row configuration.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths.
 * @returns {Promise<object>} the fresh table, a status where it may have moved,
 *   and whether one remote still wants credentials.
 */
async function remoteOf(cwd, sessionId, payload, settings, touchedBySession) {
  const root = await repoRoot(cwd, settings)
  const action = payload?.action
  const name = revName(payload?.name, 'remote name')
  let output = ''
  let needsAuth = false
  if (action === 'add') {
    await mustGit(root, ['remote', 'add', name, remoteUrl(payload.url)], undefined, settings, 'remote-failed')
    const fetched = await runGit(root, ['fetch', '--prune', name], { timeoutMs: 180_000 }, settings)
    output = fetched.code === 0
      ? textOf(fetched)
      : `remote ${name} added, but the first fetch failed:\n${textOf(fetched)}`
    needsAuth = fetched.code !== 0 && authBlocked(textOf(fetched))
  } else if (action === 'remove') {
    output = textOf(await mustGit(root, ['remote', 'remove', name], undefined, settings, 'remote-failed'))
  } else if (action === 'rename') {
    const newName = revName(payload.newName, 'remote name')
    output = textOf(await mustGit(root, ['remote', 'rename', name, newName], undefined, settings, 'remote-failed'))
  } else if (action === 'set-url') {
    const args = ['remote', 'set-url']
    if (payload.push === true) args.push('--push')
    args.push(name, remoteUrl(payload.url))
    output = textOf(await mustGit(root, args, undefined, settings, 'remote-failed'))
    const check = await checkRemote(root, payload.url, settings)
    needsAuth = check.needsAuth
  } else if (action === 'credential') {
    const row = (await remoteRows(root, settings)).find(entry => entry.name === name)
    if (row === undefined) throw new ApiError('not-found', `no remote named ${name}`)
    const input = credentialInput(row.url, payload.username, payload.password)
    await mustGit(root, ['credential', 'approve'], { input }, settings, 'credential-failed')
    const check = await checkRemote(root, row.url, settings)
    needsAuth = check.needsAuth
    output = check.ok
      ? `credentials stored for ${name}`
      : `stored, but ${name} still will not take them:\n${check.message}`
  } else {
    throw new ApiError('bad-request', `unknown remote action "${String(action)}"`)
  }
  const status = await statusOf(root, sessionId, settings, touchedBySession)
  return { output, remotes: await remoteRows(root, settings), status, needsAuth, authName: needsAuth ? name : '' }
}

/* ============================== agent tool ============================== */

/**
 * Build the `git_commit` tool definition.
 * @param {object} settings - normalized row configuration.
 * @param {{ ensure: (agent: unknown, signal: AbortSignal) => Promise<string> }} workingDirectory - Session directory service.
 * @param {Map<string, Set<string>>} touchedBySession - session-touched paths for the post-commit status.
 * @returns {object} registry-ready tool definition.
 */
function commitTool(settings, workingDirectory, touchedBySession) {
  return {
    name: 'git_commit',
    description:
      'Commit uncommitted changes of this project with git. Stages the selected paths (or every changed path when omitted) '
      + 'and creates one commit with the given message. It never pushes. Use the sidebar "改动" panel when a person should review the diff.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: {
          type: 'string',
          description: 'Commit message. Required and must not be blank.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repository-relative paths to include. Omit to commit every uncommitted change.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hash: { type: 'string', description: 'Abbreviated commit hash.' },
          subject: { type: 'string', description: 'Committed subject line.' },
          branch: { type: 'string', description: 'Current branch, empty when detached.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Committed paths.' },
        },
        required: ['hash', 'subject', 'branch', 'files'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Committed ${value.hash} ${value.subject}\n${value.branch === '' ? 'detached HEAD' : `branch ${value.branch}`} · ${value.files.length} file(s): ${value.files.join(', ')}`,
      }],
    },
    async execute(args, exec) {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        throw new Error('message must be a non-empty string')
      }
      if (exec.agent === undefined) {
        throw new Error('git_commit requires an agent session')
      }
      const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
      const result = await commitOf(cwd, exec.agent.id, args.message, args.paths, settings, touchedBySession)
      return {
        hash: result.commit.hash,
        subject: result.commit.subject,
        branch: result.status?.repo?.branch ?? '',
        files: result.commit.files,
      }
    },
  }
}

/**
 * Normalize an unknown error into a message.
 * @param {unknown} error - thrown value.
 * @returns {string} message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
