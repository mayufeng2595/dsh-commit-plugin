import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { apply, Config } from '../index.js'

const dir = await mkdtemp(join(tmpdir(), 'dshgc-'))
const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

git(['init', '-q'])
git(['config', 'user.email', 'test@example.com'])
git(['config', 'user.name', 'Test'])
await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
await writeFile(join(dir, 'b.txt'), 'bee\n')
git(['add', '-A'])
git(['commit', '-qm', 'init'])
await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
await writeFile(join(dir, 'c.txt'), 'new\nfile\n')
await writeFile(join(dir, 'b.txt'), 'bee\nmore\n')
git(['add', 'b.txt'])
await writeFile(join(dir, 'b.txt'), 'bee\nmore\nmore\n')

let route
const listeners = new Map()
const disposers = []
const ctx = {
  effect: (fn, label) => { const dispose = fn(); disposers.push([label, dispose]) },
  on: (event, listener) => { listeners.set(event, listener); return () => {} },
  inject: () => {},
  logger: { warn: (message) => console.error('[warn]', message) },
  webServer: { register: (registered) => { route = registered; return () => {} } },
}
apply(ctx, { agentCommit: 'forbid' })
assert.equal(route.path, '/dsh-git-commit/api')

const server = createServer((req, res) => { void route.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const call = async (method, payload) => {
  const response = await fetch(`${origin}/dsh-git-commit/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true, JSON.stringify(body))
  return body.data
}

const status = await call('status', { cwd: dir })
console.log('status', JSON.stringify(status, null, 2))
assert.equal(status.repo.branch, 'main')
assert.equal(status.files.length, 3)
const a = status.files.find(file => file.path === 'a.txt')
assert.equal(a.kind, 'modified')
assert.ok(a.additions >= 1 && a.deletions >= 1)
assert.ok(status.files.some(file => file.path === 'c.txt' && file.kind === 'untracked'))
assert.equal(a.touched, false)

listeners.get('tools/result')({ name: 'write', agent: { id: 'session-1' }, arguments: { file_path: join(dir, 'a.txt') } }, { isError: false })
const touchedStatus = await call('status', { cwd: dir, sessionId: 'session-1' })
console.log('touched', touchedStatus.files.filter(file => file.touched).map(file => file.path))
assert.ok(touchedStatus.files.some(file => file.path === 'a.txt' && file.touched === true))
assert.ok(touchedStatus.files.filter(file => file.touched).length === 1)

const diff = await call('diff', { cwd: dir, path: 'a.txt' })
console.log('diff a.txt\n' + diff.diff)
assert.match(diff.diff, /\+TWO/)

// Preview: a tracked file yields aligned two-column rows, an untracked file
// yields its full content as added lines.
const trackedPreview = await call('preview', { cwd: dir, path: 'a.txt' })
console.log('preview a.txt', trackedPreview.rows.slice(0, 8))
assert.equal(trackedPreview.kind, 'text')
assert.equal(trackedPreview.untracked, false)
const modified = trackedPreview.rows.filter(row => row.type === 'mod')
assert.ok(modified.length >= 1, 'a modified line pairs old and new text')
assert.equal(modified[0].oldText, 'two')
assert.equal(modified[0].newText, 'TWO')
assert.ok(modified[0].oldNo > 0 && modified[0].newNo > 0)
assert.ok(trackedPreview.rows.some(row => row.type === 'add' && row.newText === 'three'))
// The whole file comes back, not three lines around each change: a line far
// away from the edit is still present as context.
const fullContext = trackedPreview.rows.filter(row => row.type === 'ctx')
assert.ok(fullContext.length >= 1, 'unchanged lines are part of the payload')
const untrackedWhole = await call('preview', { cwd: dir, path: 'a.txt' })
assert.equal(untrackedWhole.rows.some(row => row.type === 'hunk' && String(row.text).includes('@@ -1')), true)
const untrackedPreviewRows = await call('preview', { cwd: dir, path: 'c.txt' })
console.log('preview c.txt', untrackedPreviewRows.rows)
assert.equal(untrackedPreviewRows.untracked, true)
assert.deepEqual(untrackedPreviewRows.rows.map(row => row.newText), ['new', 'file'])
assert.deepEqual(untrackedPreviewRows.rows.map(row => row.newNo), [1, 2])
assert.equal(untrackedPreviewRows.additions, 2)

const untrackedDiff = await call('diff', { cwd: dir, path: 'c.txt' })
console.log('diff c.txt\n' + untrackedDiff.diff)
assert.match(untrackedDiff.diff, /\+new/)
assert.match(untrackedDiff.diff, /^--- \/dev\/null/)

const committed = await call('commit', { cwd: dir, message: 'only a.txt', paths: ['a.txt'] })
console.log('commit', committed.commit)
assert.equal(committed.commit.files.length, 1)
assert.equal(committed.commit.files[0], 'a.txt')
const after = committed.status
console.log('after', after.files.map(file => [file.path, file.kind, file.index, file.worktree]))
assert.ok(!after.files.some(file => file.path === 'a.txt'))
assert.ok(after.files.some(file => file.path === 'c.txt'))
assert.equal(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }).trim(), 'only a.txt')
assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim(), 'b.txt')

const bad = await fetch(`${origin}/dsh-git-commit/api/commit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cwd: dir, message: '' }),
})
assert.equal(bad.status, 400)
console.log('empty message ->', (await bad.json()).error)

const notRepo = await call('status', { cwd: tmpdir() })
console.log('notRepo', notRepo.reason)
assert.equal(notRepo.repo, null)

// Discard an untracked file, then a tracked file with staged+unstaged changes.
const rolledUntracked = await call('rollback', { cwd: dir, paths: ['c.txt'] })
assert.deepEqual(rolledUntracked.rolledBack, ['c.txt'])
assert.ok(!rolledUntracked.status.files.some(file => file.path === 'c.txt'))
const rolledTracked = await call('rollback', { cwd: dir, paths: ['b.txt'] })
assert.deepEqual(rolledTracked.rolledBack, ['b.txt'])
assert.equal(rolledTracked.status.files.length, 0)
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '')
assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'b.txt'), 'utf8'), 'bee\n')

// `placement` is the row Config the browser half needs but never sees, so the
// `config` route is the only way it travels. Omitted means the tab seat.
assert.deepEqual(await call('config', {}), { placement: 'tab' })

await rm(dir, { recursive: true, force: true })
console.log('SMOKE OK')

// Second scenario: initial commit in an empty repository, then a rename.
const dir2 = await mkdtemp(join(tmpdir(), 'dshgc2-'))
const git2 = args => execFileSync('git', args, { cwd: dir2, encoding: 'utf8' })
git2(['init', '-q'])
git2(['config', 'user.email', 'test@example.com'])
git2(['config', 'user.name', 'Test'])
await writeFile(join(dir2, 'first.txt'), 'hello\n')
const untrackedFirst = await call('diff', { cwd: dir2, path: 'first.txt' })
assert.match(untrackedFirst.diff, /\+hello/)
git2(['add', 'first.txt'])
const stagedFirst = await call('diff', { cwd: dir2, path: 'first.txt' })
console.log('staged-first diff\n' + stagedFirst.diff)
assert.match(stagedFirst.diff, /\+hello/)
const emptyStatus = await call('status', { cwd: dir2 })
assert.equal(emptyStatus.repo.head, null)
assert.equal(emptyStatus.files.length, 1)
const firstCommit = await call('commit', { cwd: dir2, message: 'initial', paths: ['first.txt'], push: true })
console.log('initial commit', firstCommit.commit, firstCommit.push)
assert.equal(firstCommit.push.ok, false)
// A branch with no upstream now pushes to the default remote, but this
// repository has no remote at all, so there is nowhere to create one.
assert.equal(firstCommit.push.code, 'no-remote')
assert.equal(firstCommit.commit.hash.length >= 7, true)

git2(['mv', 'first.txt', 'renamed.txt'])
const renameStatus = await call('status', { cwd: dir2 })
console.log('rename status', renameStatus.files.map(file => [file.path, file.origPath, file.kind]))
assert.equal(renameStatus.files.length, 1)
assert.equal(renameStatus.files[0].path, 'renamed.txt')
assert.equal(renameStatus.files[0].origPath, 'first.txt')
assert.equal(renameStatus.files[0].kind, 'renamed')
const renameDiff = await call('diff', { cwd: dir2, path: 'renamed.txt', origPath: 'first.txt' })
console.log('rename diff\n' + renameDiff.diff)
assert.match(renameDiff.diff, /rename/)
const renameCommit = await call('commit', { cwd: dir2, message: 'rename', paths: ['renamed.txt'] })
console.log('rename commit', renameCommit.commit)
assert.deepEqual(renameCommit.commit.files, ['renamed.txt', 'first.txt'])
assert.equal(renameCommit.status.files.length, 0)

await rm(dir2, { recursive: true, force: true })
console.log('SMOKE2 OK')

// Third scenario: a conflicted merge is refused, and '#' message lines survive.
const dir3 = await mkdtemp(join(tmpdir(), 'dshgc3-'))
const git3 = args => execFileSync('git', args, { cwd: dir3, encoding: 'utf8' })
git3(['init', '-q'])
git3(['config', 'user.email', 'test@example.com'])
git3(['config', 'user.name', 'Test'])
await writeFile(join(dir3, 'c.txt'), 'base\n')
git3(['add', '-A'])
git3(['commit', '-qm', 'base #42'])
assert.match(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir3, encoding: 'utf8' }), /#42/)
git3(['checkout', '-qb', 'side'])
await writeFile(join(dir3, 'c.txt'), 'side\n')
git3(['commit', '-qam', 'side'])
git3(['checkout', '-q', 'main'])
await writeFile(join(dir3, 'c.txt'), 'main\n')
git3(['commit', '-qam', 'main'])
try { git3(['merge', 'side']) } catch { /* expected conflict */ }
const conflictStatus = await call('status', { cwd: dir3 })
console.log('conflict status', conflictStatus.files.map(file => [file.path, file.kind]))
assert.ok(conflictStatus.files.some(file => file.path === 'c.txt' && file.kind === 'conflict'))
const conflictCommit = await fetch(`${origin}/dsh-git-commit/api/commit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cwd: dir3, message: 'should fail', paths: ['c.txt'] }),
})
assert.equal(conflictCommit.status, 400)
const conflictError = (await conflictCommit.json()).error
console.log('conflict commit ->', conflictError)
assert.equal(conflictError.code, 'unresolved-conflict')
await rm(dir3, { recursive: true, force: true })
console.log('SMOKE3 OK')

// Fourth scenario: discovery finds nested repositories under a multi-project root.
const dir4 = await mkdtemp(join(tmpdir(), 'dshgc4-'))
const { mkdir } = await import('node:fs/promises')
await mkdir(join(dir4, 'project-a'), { recursive: true })
await mkdir(join(dir4, 'tools/helper'), { recursive: true })
await mkdir(join(dir4, 'notes'), { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: join(dir4, 'project-a') })
execFileSync('git', ['init', '-q'], { cwd: join(dir4, 'tools/helper') })
await writeFile(join(dir4, 'notes/readme.txt'), 'plain folder\n')
const discoveredRepos = await call('discover', { cwd: dir4 })
console.log('discovered', discoveredRepos)
assert.equal(discoveredRepos.truncated, false)
assert.deepEqual(discoveredRepos.repos.map(repo => repo.name).sort(), ['helper', 'project-a'])
// cached answer is stable and refresh recomputes
const again = await call('discover', { cwd: dir4 })
assert.deepEqual(again, discoveredRepos)
execFileSync('git', ['init', '-q'], { cwd: join(dir4, 'notes') })
const refreshed = await call('discover', { cwd: dir4, refresh: true })
assert.equal(refreshed.repos.length, 3)
const missing = await fetch(`${origin}/dsh-git-commit/api/discover`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cwd: join(tmpdir(), 'definitely-missing-dshgc') }),
})
assert.equal(missing.status, 404)
await rm(dir4, { recursive: true, force: true })
console.log('SMOKE4 OK')

// Fourth-and-a-half scenario: a file deleted from the working tree still has a
// preview (the HEAD content, all lines removed) instead of failing.
{
  const dir6 = await mkdtemp(join(tmpdir(), 'dshgc6-'))
  execFileSync('git', ['init', '-q'], { cwd: dir6 })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir6 })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir6 })
  await writeFile(join(dir6, 'gone.txt'), 'one\ntwo\n')
  execFileSync('git', ['add', '-A'], { cwd: dir6 })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir6 })
  await rm(join(dir6, 'gone.txt'))
  const deleted = await call('preview', { cwd: dir6, path: 'gone.txt' })
  assert.equal(deleted.untracked, false, 'a deleted file is still compared against HEAD')
  assert.ok(deleted.deletions >= 2, 'every removed line is reported')
  assert.ok(deleted.rows.some(row => row.type === 'del' && row.oldText === 'one'))
  assert.equal(deleted.rows.some(row => row.newText !== undefined && row.newText !== null), false)
  await rm(dir6, { recursive: true, force: true })
}
console.log('SMOKE DELETED OK')

// Working-tree edit round trip: read the file, write it back, see the diff.
{
  const dir7 = await mkdtemp(join(tmpdir(), 'dshgc7-'))
  execFileSync('git', ['init', '-q'], { cwd: dir7 })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir7 })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir7 })
  await writeFile(join(dir7, 'edit.txt'), 'alpha\n')
  const source = await call('read', { cwd: dir7, path: 'edit.txt' })
  assert.equal(source.content, 'alpha\n')
  const written = await call('write', { cwd: dir7, path: 'edit.txt', content: 'alpha\nbeta\n' })
  assert.equal(written.bytes, 11)
  assert.equal(await (await import('node:fs/promises')).readFile(join(dir7, 'edit.txt'), 'utf8'), 'alpha\nbeta\n')
  const after = await call('preview', { cwd: dir7, path: 'edit.txt' })
  assert.ok(after.rows.some(row => row.type === 'add' && row.newText === 'beta'), 'the new line shows up')
  // Escaping the repository is refused.
  await assert.rejects(() => call('write', { cwd: dir7, path: '../escape.txt', content: 'x' }), /repository|path/i)
  await rm(dir7, { recursive: true, force: true })
}
console.log('SMOKE EDIT OK')

// Fifth scenario: a plain folder can be initialized into a repository.
const dir5 = await mkdtemp(join(tmpdir(), 'dshgc5-'))
await writeFile(join(dir5, 'notes.md'), '# draft\n')
const beforeInit = await call('status', { cwd: dir5 })
assert.equal(beforeInit.repo, null)
assert.equal(beforeInit.reason, 'not-a-repository')
const initialized = await call('init', { cwd: dir5, sessionId: 's5' })
assert.ok(initialized.repo !== null, 'init returns a repository status')
assert.equal(initialized.repo.root, execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir5, encoding: 'utf8' }).trim())
assert.ok(initialized.files.some(file => file.path === 'notes.md' && file.kind === 'untracked'))
assert.deepEqual(initialized.created, ['.gitignore'])
assert.ok(initialized.files.some(file => file.path === '.gitignore' && file.kind === 'untracked'))
const ignoreText = await (await import('node:fs/promises')).readFile(join(dir5, '.gitignore'), 'utf8')
assert.match(ignoreText, /node_modules\//)
assert.equal(initialized.repo.branch, 'main')
// Initializing again is a no-op that still answers with the status and never
// overwrites an existing scaffold file.
await (await import('node:fs/promises')).writeFile(join(dir5, '.gitignore'), 'custom\n')
const reinit = await call('init', { cwd: dir5 })
assert.equal(reinit.repo.root, initialized.repo.root)
assert.equal(await (await import('node:fs/promises')).readFile(join(dir5, '.gitignore'), 'utf8'), 'custom\n')
const discoverAfter = await call('discover', { cwd: dirname(dir5) })
assert.ok(discoverAfter.repos.some(repo => repo.path.endsWith(basename(dir5)) || repo.name === basename(dir5)))
await rm(dir5, { recursive: true, force: true })

// Re-applying with `placement: sidebar` swaps the mounted route, and the answer
// is what decides which seat the Client mounts. Any other value keeps `tab`.
apply(ctx, { agentCommit: 'forbid', placement: 'sidebar' })
assert.deepEqual(await call('config', {}), { placement: 'sidebar' })
apply(ctx, { agentCommit: 'forbid', placement: 'nonsense' })
assert.deepEqual(await call('config', {}), { placement: 'tab' })
server.close()
console.log('SMOKE5 OK')

// The volatile `placement` field is how the GUI reaches this plugin: the DSH
// settings service projects `Config` into a form, the Loader commits a write
// into the running reference, and the `config` route follows it live.
{
  // The schema the settings service projects: `placement` volatile, the rest
  // ordinary configuration that stays out of the form.
  assert.equal(Config.meta.volatile, undefined, 'the object itself is not one live field')
  assert.equal(Config.dict.placement.meta.volatile, true, 'placement is editable without a remount')
  assert.equal(Config.dict.agentCommit.meta.volatile, undefined, 'the agent gate is deployment only')
  // Resolving through the schema is what the Loader does: a volatile field
  // arrives as a reference, an ordinary one as a value.
  const resolved = Config({ agentCommit: 'forbid' })
  assert.equal(typeof resolved.placement.get, 'function', 'placement arrives as a live reference')
  assert.equal(resolved.placement.get(), 'tab')
  assert.equal(resolved.agentCommit, 'forbid')
  assert.throws(() => Config({ placement: 'deck' }), /placement/, 'the form cannot write a junk seat')
  // The serialized envelope is what a configuration surface renders from, and
  // it carries the volatile marker through to the field node.
  const wire = Config.toJSON()
  const placementRef = wire.refs[wire.refs[wire.uid].dict.placement]
  assert.equal(placementRef.meta.volatile, true, 'the envelope keeps the volatile marker')
  assert.deepEqual(placementRef.list.map(id => wire.refs[id].value), ['tab', 'sidebar'])

  // The host reads the reference on every request, so a committed value needs
  // no re-apply. `updateVolatile` is the Loader's internal commit; the test
  // drives the same reference shape directly.
  let committed = 'tab'
  const guiCtx = {
    effect: (fn, label) => { const dispose = fn(); disposers.push([label, dispose]) },
    on: () => () => {},
    inject: () => {},
    logger: { warn: () => {} },
    webServer: { register: (registered2) => { route = registered2; return () => {} } },
  }
  apply(guiCtx, { agentCommit: 'forbid', placement: { get: () => committed } })

  const server2 = createServer((req, res) => { void route.handler(req, res) })
  await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
  const origin2 = `http://127.0.0.1:${String(server2.address().port)}`
  const call2 = async (method, payload) => {
    const response = await fetch(`${origin2}/dsh-git-commit/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    return (await response.json()).data
  }
  assert.deepEqual(await call2('config', {}), { placement: 'tab' })
  committed = 'sidebar'
  assert.deepEqual(await call2('config', {}), { placement: 'sidebar' }, 'a committed choice is what travels')
  committed = 'tab'
  assert.deepEqual(await call2('config', {}), { placement: 'tab' }, 'and so is a reset back to the row Config')
  server2.close()
}
console.log('SMOKE6 OK')

// Seventh scenario: the branch popup family against a real remote. Push creates
// its own upstream, then fetch / pull / checkout (plain, smart, refused) /
// branch create-rename-delete / merge / rebase / compare / tracking / stash.
{
  const work = await mkdtemp(join(tmpdir(), 'dshgc-work-'))
  const seed = await mkdtemp(join(tmpdir(), 'dshgc-seed-'))
  const remote = await mkdtemp(join(tmpdir(), 'dshgc-remote-'))
  const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  /**
   * Start one repository with a fixed identity, on `main`.
   * @param {string} cwd - the directory.
   */
  const setup = (cwd) => {
    run(cwd, ['init', '-q', '-b', 'main'])
    run(cwd, ['config', 'user.email', 'test@example.com'])
    run(cwd, ['config', 'user.name', 'Test'])
    run(cwd, ['config', 'commit.gpgsign', 'false'])
  }
  setup(work)
  run(remote, ['init', '--bare', '-q', '-b', 'main'])
  await writeFile(join(work, 'a.txt'), 'one\n')
  run(work, ['add', '-A'])
  run(work, ['commit', '-qm', 'work base'])
  run(work, ['remote', 'add', 'origin', remote])

  const server3 = createServer((req, res) => { void route.handler(req, res) })
  await new Promise(resolve => server3.listen(0, '127.0.0.1', resolve))
  const origin3 = `http://127.0.0.1:${String(server3.address().port)}`
  /**
   * Call one method and require success.
   * @param {string} method - route suffix.
   * @param {object} payload - JSON body.
   * @returns {Promise<object>} the data envelope.
   */
  const api3 = async (method, payload) => {
    const response = await fetch(`${origin3}/dsh-git-commit/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const body = await response.json()
    assert.equal(body.ok, true, `${method}: ${JSON.stringify(body)}`)
    return body.data
  }
  /**
   * Call one method and require the failure envelope.
   * @param {string} method - route suffix.
   * @param {object} payload - JSON body.
   * @returns {Promise<{ status: number, code: string, message: string }>} the error.
   */
  const fails3 = async (method, payload) => {
    const response = await fetch(`${origin3}/dsh-git-commit/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const body = await response.json()
    assert.notEqual(body.ok, true, `${method} was expected to fail`)
    return { status: response.status, ...body.error }
  }
  /**
   * Write one file and commit it through the panel's own endpoint.
   * @param {string} name - repository-relative path.
   * @param {string} text - file body.
   * @param {string} message - commit message.
   */
  const commitFile = async (name, text, message) => {
    await writeFile(join(work, name), text)
    run(work, ['add', '--', name])
    await api3('commit', { cwd: work, message, paths: [name] })
  }

  const fresh = await api3('branches', { cwd: work })
  assert.equal(fresh.current, 'main')
  assert.equal(fresh.detached, false)
  assert.equal(fresh.state, null)
  assert.deepEqual(fresh.remotes, ['origin'])
  assert.equal(fresh.upstream, '')
  assert.deepEqual(fresh.local.map(branch => branch.name), ['main'])
  assert.equal(fresh.local[0].current, true)
  assert.equal(fresh.remote.length, 0)

  // No upstream and no remote branch yet: push makes origin/main and links it.
  const pushed = await api3('push', { cwd: work })
  assert.equal(pushed.setUpstream, true)
  const afterPush = await api3('branches', { cwd: work })
  assert.equal(afterPush.upstream, 'origin/main')
  assert.equal(afterPush.dirty, false)
  assert.ok(afterPush.remote.some(branch => branch.name === 'origin/main'))

  // A second clone moves the remote branch, and the panel catches up.
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, seed])
  await writeFile(join(seed, 'b.txt'), 'seed\n')
  run(seed, ['add', '-A'])
  run(seed, ['commit', '-qm', 'seed adds b'])
  run(seed, ['push', '-q'])
  await api3('fetch', { cwd: work })
  assert.equal((await api3('status', { cwd: work })).repo.behind, 1)
  const pulled = await api3('pull', { cwd: work })
  assert.equal(pulled.status.repo.behind, 0)
  assert.equal(pulled.status.files.length, 0)

  // Branch create + checkout, then stash away and back over a dirty file.
  const created = await api3('branch', { cwd: work, action: 'create', name: 'feature', checkout: true })
  assert.equal(created.status.repo.branch, 'feature')
  await writeFile(join(work, 'a.txt'), 'dirty\n')
  assert.equal((await api3('stash', { cwd: work, action: 'push' })).status.files.length, 0)
  assert.equal((await api3('branches', { cwd: work })).stash, 1)
  assert.equal((await api3('stash', { cwd: work, action: 'pop' })).status.files.length, 1)

  // Smart checkout carries the dirty file across; a plain one refuses.
  const smart = await api3('checkout', { cwd: work, rev: 'main', smart: true })
  assert.equal(smart.status.repo.branch, 'main')
  assert.equal(smart.stashed, true)
  assert.equal(smart.stashKept, false)
  assert.equal(smart.status.files.length, 1)
  assert.equal((await api3('branches', { cwd: work })).stash, 0)
  const refused = await fails3('checkout', { cwd: work, rev: 'feature' })
  assert.equal(refused.code, 'local-changes')
  assert.equal(refused.status, 409)
  await api3('rollback', { cwd: work, paths: ['a.txt'] })
  assert.equal((await api3('checkout', { cwd: work, rev: 'feature' })).status.repo.branch, 'feature')

  // Compare reads one branch against the working HEAD.
  await commitFile('f.txt', 'feature\n', 'feature work')
  const compared = await api3('compare', { cwd: work, ref: 'main' })
  assert.equal(compared.ahead, 0)
  assert.equal(compared.behind, 1)
  assert.ok(compared.files.some(file => file.path === 'f.txt' && file.status === 'D'))
  assert.deepEqual(compared.aheadCommits, [], 'main holds nothing that feature lacks')
  assert.ok(compared.behindCommits.some(commit => commit.subject === 'feature work'))

  // Merge: main takes feature's work, here as a fast-forward.
  await api3('checkout', { cwd: work, rev: 'main' })
  const merged = await api3('merge', { cwd: work, ref: 'feature' })
  assert.equal(merged.status.files.length, 0)
  assert.match(run(work, ['log', '-1', '--pretty=%s']), /feature work/)

  // Rebase: a divergent branch lands cleanly on top of main.
  await api3('branch', { cwd: work, action: 'create', name: 'rb', checkout: true })
  await commitFile('r.txt', 'rb\n', 'rb work')
  await api3('checkout', { cwd: work, rev: 'main' })
  await commitFile('m.txt', 'from main\n', 'main work')
  await api3('checkout', { cwd: work, rev: 'rb' })
  const rebased = await api3('rebase', { cwd: work, onto: 'main' })
  assert.equal(rebased.status.repo.state, null)
  assert.equal((await api3('compare', { cwd: work, ref: 'main' })).ahead, 0)

  // A conflicting merge stops with the operation still open, and aborts clean.
  await api3('checkout', { cwd: work, rev: 'main' })
  await api3('branch', { cwd: work, action: 'create', name: 'bad', checkout: true })
  await commitFile('m.txt', 'from bad\n', 'bad change')
  await api3('checkout', { cwd: work, rev: 'main' })
  await commitFile('m.txt', 'from main again\n', 'main change again')
  const mergeFail = await fails3('merge', { cwd: work, ref: 'bad' })
  assert.equal(mergeFail.code, 'merge-interrupted')
  const midMerge = await api3('status', { cwd: work })
  assert.equal(midMerge.repo.state, 'merge')
  assert.ok(midMerge.files.some(file => file.kind === 'conflict'))
  assert.equal((await api3('merge', { cwd: work, action: 'abort' })).status.repo.state, null)

  // The same shape for a rebase that cannot finish.
  await api3('checkout', { cwd: work, rev: 'bad' })
  const rebaseFail = await fails3('rebase', { cwd: work, onto: 'main' })
  assert.equal(rebaseFail.code, 'rebase-interrupted')
  assert.equal((await api3('status', { cwd: work })).repo.state, 'rebase')
  assert.equal((await api3('rebase', { cwd: work, action: 'abort' })).status.repo.state, null)

  // Tracking branch: set, read back, unset.
  await api3('tracking', { cwd: work, branch: 'rb', upstream: 'origin/main' })
  assert.equal((await api3('branches', { cwd: work })).local.find(branch => branch.name === 'rb').upstream, 'origin/main')
  await api3('tracking', { cwd: work, branch: 'rb', upstream: '' })
  assert.equal((await api3('branches', { cwd: work })).local.find(branch => branch.name === 'rb').upstream, '')

  // Rename, then delete: unmerged needs the force flag.
  await api3('checkout', { cwd: work, rev: 'main' })
  const renamed = await api3('branch', { cwd: work, action: 'rename', name: 'bad', newName: 'bad2' })
  assert.ok(renamed.status.repo.branch === 'main')
  assert.equal((await fails3('branch', { cwd: work, action: 'delete', name: 'bad2' })).code, 'branch-failed')
  const forceDeleted = await api3('branch', { cwd: work, action: 'delete', name: 'bad2', force: true })
  assert.ok(!forceDeleted.output.includes('error'))
  assert.ok(!(await api3('branches', { cwd: work })).local.some(branch => branch.name === 'bad2'))

  // A tag is a checkout target, and it leaves a detached HEAD.
  run(work, ['tag', 'v9.9.9'])
  const detached = await api3('checkout', { cwd: work, rev: 'v9.9.9' })
  assert.equal(detached.status.repo.detached, true)
  assert.equal(detached.status.repo.branch, null)
  const detachedTable = await api3('branches', { cwd: work })
  assert.equal(detachedTable.detached, true)
  assert.equal(detachedTable.current, '')
  assert.ok(detachedTable.tags.some(tag => tag.name === 'v9.9.9'))
  await api3('checkout', { cwd: work, rev: 'main' })

  // Rewriting history makes a plain push impossible; the lease-protected one works.
  await api3('branch', { cwd: work, action: 'create', name: 'amp', checkout: true })
  await commitFile('amp.txt', 'amp\n', 'amp work')
  await api3('push', { cwd: work })
  run(work, ['reset', '-q', '--hard', 'HEAD~1'])
  assert.equal((await fails3('push', { cwd: work })).code, 'push-failed')
  const forced = await api3('push', { cwd: work, force: true })
  assert.ok(forced.output.includes('forced update'), forced.output)
  await api3('checkout', { cwd: work, rev: 'main' })

  // Update with the rebase strategy: the local commit ends on top.
  await commitFile('later.txt', 'later\n', 'local ahead')
  await writeFile(join(seed, 'seed2.txt'), 'seed2\n')
  run(seed, ['add', '-A'])
  run(seed, ['commit', '-qm', 'seed ahead'])
  run(seed, ['push', '-q'])
  const rebasedAgain = await api3('pull', { cwd: work, strategy: 'rebase' })
  assert.equal(rebasedAgain.status.repo.behind, 0)
  assert.match(run(work, ['log', '-1', '--pretty=%s']), /local ahead/)

  // Remotes: read the table, add one (which fetches it), re-point, rename, remove.
  const table = await api3('remotes', { cwd: work })
  assert.deepEqual(table.remotes.map(row => row.name), ['origin'])
  assert.equal(table.remotes[0].url, remote)
  assert.equal(table.remotes[0].pushUrl, '')
  const added = await api3('remote', { cwd: work, action: 'add', name: 'peer', url: seed })
  assert.ok(added.remotes.some(row => row.name === 'peer'))
  assert.ok((await api3('branches', { cwd: work })).remote.some(branch => branch.name === 'peer/main'))
  const repointed = await api3('remote', { cwd: work, action: 'set-url', name: 'peer', url: remote })
  assert.equal(repointed.remotes.find(row => row.name === 'peer').url, remote)
  const renamedRemote = await api3('remote', { cwd: work, action: 'rename', name: 'peer', newName: 'peer2' })
  assert.deepEqual(renamedRemote.remotes.map(row => row.name).sort(), ['origin', 'peer2'])
  const removed = await api3('remote', { cwd: work, action: 'remove', name: 'peer2' })
  assert.deepEqual(removed.remotes.map(row => row.name), ['origin'])
  assert.equal((await fails3('remote', { cwd: work, action: 'add', name: 'bad', url: '' })).code, 'bad-request')
  assert.equal((await fails3('remote', { cwd: work, action: 'add', name: '  ', url: remote })).code, 'bad-request')
  assert.equal((await fails3('remote', { cwd: work, action: 'add', name: 'bad', url: '--help' })).code, 'bad-url')
  // Even the last remote can go, and come back.
  assert.deepEqual((await api3('remote', { cwd: work, action: 'remove', name: 'origin' })).remotes, [])
  assert.equal((await fails3('push', { cwd: work })).code, 'no-remote', 'a repository with no remote cannot push')
  await api3('remote', { cwd: work, action: 'add', name: 'origin', url: remote })

  // Names that git would read as an option, or that are not one name at all.
  assert.equal((await fails3('checkout', { cwd: work, rev: '--force' })).code, 'bad-ref')
  assert.equal((await fails3('checkout', { cwd: work, rev: 'two words' })).code, 'bad-ref')
  assert.equal((await fails3('compare', { cwd: work, ref: 'no-such-branch' })).code, 'unknown-revision')

  await rm(work, { recursive: true, force: true })
  await rm(seed, { recursive: true, force: true })
  await rm(remote, { recursive: true, force: true })
  server3.close()
}
console.log('SMOKE7 OK')
