/**
 * Browser-half smoke: the panel mounts into exactly one seat, chosen by the
 * Host's `placement` answer — the conversation view tab (`tab`, the default)
 * or a right-sidebar tab (`sidebar`). When the client is served the
 * plugin configuration form, that form is the live source: it wins
 * over the Host answer and moves the panel without a reload.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'client.js'), 'utf8')

let registration
/** The placement the fake Host answers for `config`; set per case. */
let servedPlacement = 'tab'
/** Whether the fake Host serves `config` at all (the fallback case). */
let serveConfig = true
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, JSON, Math, Object, Array, Error, Symbol, Set, Map, WeakMap, String, Number, Boolean, Date, RegExp, AbortController, TextEncoder, URL,
  fetch: async (url) => {
    if (String(url).includes('/discover')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { repos: [{ path: '/repo/one', name: 'one' }], truncated: false } }) }
    }
    if (String(url).includes('/config')) {
      if (!serveConfig) return { ok: false, status: 404, text: async () => '{}' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { placement: servedPlacement } }) }
    }
    return { ok: false, status: 404, text: async () => '{}' }
  },
  window: {
    localStorage: (() => { const store = new Map(); return { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) } })(),
    __ModuleLoader__: {
      load(options) { registration = options },
    },
  },
}
vm.runInNewContext(code, sandbox, { filename: 'client.js' })
assert.equal(registration.id, '@local/dsh-git-commit')

function useStub() { throw new Error('hook called outside a component render') }
class Component {
  constructor(props) { this.props = props }
  setState() {}
}
const React = {
  Component,
  useState: useStub,
  useEffect: useStub,
  useLayoutEffect: useStub,
  useMemo: useStub,
  useRef: useStub,
  useCallback: useStub,
  createElement: () => null,
  Fragment: Symbol('Fragment'),
}
const plugin = registration.factory(() => React)
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale'])

const sessionsList = { byId: { s1: { id: 's1', cwd: '/repo/one', updatedAt: 5, retainedBy: { mainView: 1 } } }, ids: ['s1'] }

/**
 * Stand-in for the client-side settings scope: a snapshot plus subscribers, and
 * the `publish` a case uses to play a Host commit.
 * @param {object} initial - the first snapshot.
 * @returns {object} the scope.
 */
function createScope(initial) {
  const listeners = new Set()
  let snapshot = initial
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    /** What the card wrote, so a case can check the field name and value. */
    writes: [],
  }
  scope.publish = (next) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  scope.set = async (field, value) => {
    scope.writes.push(['set', field, value])
    scope.publish({
      ...snapshot,
      value: { ...snapshot.value, [field]: value },
      user: { ...snapshot.user, [field]: value },
    })
  }
  scope.unset = async (field) => {
    scope.writes.push(['unset', field])
    const user = { ...snapshot.user }
    delete user[field]
    scope.publish({ ...snapshot, value: { ...snapshot.base }, user })
  }
  return scope
}

/**
 * Run one `apply` against a fake host and collect what it mounted.
 * @param {object} options - case setup.
 * @param {boolean} options.withSidebar - whether the sidebar services exist.
 * @param {object | null} options.scope - settings scope served for `git-commit`,
 *   or null for a deployment with no settings service at all.
 * @returns {Promise<object>} what was registered, plus the disposers.
 */
async function runCase({ withSidebar = true, scope = null } = {}) {
  const seats = []
  const tabTypes = []
  const cleanups = []
  const viewSeatCallbacks = []
  const sidebarSeatCallbacks = []
  const cardCallbacks = []
  /** Seat and card disposers this case ran, in order. */
  const disposed = []
  /** The entry the client bound, captured from `configForms.get`. */
  const bound = { entry: null }
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function', `effect "${label}" must return a disposer`)
      cleanups.push(dispose)
      return dispose
    },
    locale: {
      register() { return () => {} },
      bind() { return key => key },
    },
    inject(names, callback) {
      if (names.includes('sessions')) {
        callback({
          get: name => name === 'sessions' ? { list: { getSnapshot: () => sessionsList, subscribe: () => () => {} } } : undefined,
          effect: ctx.effect,
        })
      }
      if (names.includes('workspaces')) {
        callback({
          get: name => name === 'workspaces'
            ? { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: '/repo-root', sessionIds: ['s1'] }] }), subscribe: () => () => {} } }
            : undefined,
          effect: ctx.effect,
        })
      }
      if (names.includes('configForms')) {
        if (scope === null) return
        callback({
          configForms: {
            get(entryId) { bound.entry = entryId; return scope },
          },
          get: () => undefined,
          effect: ctx.effect,
          slots: ctx.slots,
        })
      }
      if (names.includes('sidebarRightTabs')) {
        if (!withSidebar) return
        callback({
          get: name => name === 'sidebarRightTabs'
            ? { register: (definition) => { tabTypes.push(definition); return () => { disposed.push('sidebar.tab-type') } } }
            : name === 'slots' ? ctx.slots : undefined,
          effect: ctx.effect,
        })
      }
    },
    get() { return undefined },
    slots: {
      inject(name, callback) {
        if (name === 'conversation.view') {
          viewSeatCallbacks.push(callback)
          return () => { disposed.push('conversation.view') }
        }
        if (name === 'sidebar.right.pane.tab') {
          sidebarSeatCallbacks.push(callback)
          return () => { disposed.push('sidebar.right.pane.tab') }
        }
        if (name === 'plugins.bundle.config') {
          cardCallbacks.push(callback)
          return () => { disposed.push('plugins.bundle.config') }
        }
        const dispose = callback()
        assert.equal(typeof dispose, 'function', `slot "${name}" injection must return a disposer`)
        return dispose
      },
      register(options) {
        seats.push(options)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  // The seat mounts after the Host answers `config`.
  await new Promise(resolve => setTimeout(resolve, 20))
  return { seats, tabTypes, viewSeatCallbacks, sidebarSeatCallbacks, cardCallbacks, bound, disposed, cleanups }
}

// 1. Default placement: the conversation view tab, as before this option.
servedPlacement = 'tab'
serveConfig = true
{
  const { seats, tabTypes, viewSeatCallbacks, sidebarSeatCallbacks, cleanups } = await runCase({ scope: createScope({ status: 'unavailable' }) })
  assert.equal(viewSeatCallbacks.length, 1, 'injects the conversation view seat')
  assert.equal(sidebarSeatCallbacks.length, 0, 'the sidebar seat stays untouched')
  assert.equal(tabTypes.length, 0, 'no sidebar tab type is registered')
  viewSeatCallbacks[0]()
  const body = seats.find(seat => seat.name === 'conversation.view')
  assert.ok(body, 'registers the view body')
  assert.equal(body.id, 'git-commit')
  assert.equal(body.locale, 'gitCommit')
  assert.equal(body.label(), 'panel.title')
  for (const dispose of cleanups) dispose()
}

// 2. `sidebar`: a right-sidebar tab type plus its body in the pane-tab slot.
servedPlacement = 'sidebar'
{
  const { seats, tabTypes, viewSeatCallbacks, sidebarSeatCallbacks, cleanups } = await runCase({ scope: createScope({ status: 'unavailable' }) })
  assert.equal(viewSeatCallbacks.length, 0, 'the conversation tab is not mounted')
  assert.equal(tabTypes.length, 1, 'registers one sidebar tab type')
  const definition = tabTypes[0]
  assert.equal(definition.id, 'git-commit')
  assert.equal(definition.kind, 'git-commit')
  assert.equal(definition.title(), 'panel.title')
  assert.equal(definition.guide.length, 1, 'the tab offers a start-page capsule')
  assert.equal(definition.guide[0].title(), 'panel.title')
  assert.equal(definition.guide[0].description(), 'guide.sidebar')
  assert.equal(sidebarSeatCallbacks.length, 1, 'injects the sidebar pane-tab seat')
  sidebarSeatCallbacks[0]()
  const body = seats.find(seat => seat.name === 'sidebar.right.pane.tab')
  assert.ok(body, 'registers the panel body for the sidebar tab')
  assert.equal(body.key, 'git-commit')
  for (const dispose of cleanups) dispose()
}

// 3. A Host without the right sidebar: `sidebar` is simply unsupported there,
// so nothing registers and nothing throws. The row stays a documented no-op.
servedPlacement = 'sidebar'
{
  const { viewSeatCallbacks, sidebarSeatCallbacks, cleanups } = await runCase({ withSidebar: false, scope: createScope({ status: 'unavailable' }) })
  assert.equal(sidebarSeatCallbacks.length, 0, 'no pane-tab seat without the services')
  assert.equal(viewSeatCallbacks.length, 0, 'and no conversation tab is forced in')
  for (const dispose of cleanups) dispose()
}

// 4. No `config` answer at all (an older Host): keep the historical tab seat.
servedPlacement = 'tab'
serveConfig = false
{
  const { viewSeatCallbacks, sidebarSeatCallbacks, cleanups } = await runCase({ scope: createScope({ status: 'unavailable' }) })
  assert.equal(viewSeatCallbacks.length, 1, 'falls back to the conversation view seat')
  assert.equal(sidebarSeatCallbacks.length, 0, 'never guesses the sidebar')
  serveConfig = true
  for (const dispose of cleanups) dispose()
}

// 5. A served configuration form: the section registers under the bundle's
// package name, and the setting wins over the Host answer.
servedPlacement = 'tab'
{
  const scope = createScope({
    status: 'ready',
    value: { placement: 'sidebar' },
    base: { placement: 'tab' },
    user: { placement: 'sidebar' },
    writable: true,
  })
  const { seats, tabTypes, viewSeatCallbacks, cardCallbacks, bound, disposed, cleanups } = await runCase({ scope })
  assert.equal(bound.entry, 'git-commit', 'binds this plugin\'s entry form')
  assert.equal(cardCallbacks.length, 1, 'contributes one configuration section')
  cardCallbacks[0]()
  const card = seats.find(seat => seat.name === 'plugins.bundle.config')
  assert.ok(card, 'registers the section on the bundle page')
  assert.equal(card.key, '@local/dsh-git-commit', 'keyed by the bundle the page is about')
  assert.equal(card.locale, 'gitCommit')
  assert.equal(card.inject().configForm, scope, 'the section reads and writes through the form')
  // The form says sidebar even though the Host route answered tab.
  assert.equal(viewSeatCallbacks.length, 0, 'the live form outranks the Host answer')
  assert.equal(tabTypes.length, 1, 'and mounts the sidebar seat')

  // 6. Flipping the setting moves the panel in place: the old seat is torn
  // down and the other one mounted, with no reload.
  scope.publish({ status: 'ready', value: { placement: 'tab' }, base: { placement: 'tab' }, user: {}, writable: true })
  assert.deepEqual(scope.writes, [], 'a Host-side change writes nothing back')
  assert.ok(viewSeatCallbacks.length === 1, 'the conversation tab is mounted')
  assert.equal(tabTypes.length, 1, 'the sidebar tab type is not re-registered')
  assert.ok(disposed.includes('sidebar.tab-type'), 'the sidebar tab type was unregistered')
  assert.ok(disposed.includes('sidebar.right.pane.tab'), 'the sidebar body seat was released')
  for (const dispose of cleanups) dispose()
}

// 7. No settings service at all (a deployment without the form surface):
// the Host answer alone still seats the panel, and no card is offered.
servedPlacement = 'sidebar'
{
  const { tabTypes, cardCallbacks, viewSeatCallbacks, cleanups } = await runCase({ scope: null })
  assert.equal(cardCallbacks.length, 0, 'no section without an entry form to edit')
  assert.equal(viewSeatCallbacks.length, 0, 'the Host answer still decides')
  assert.equal(tabTypes.length, 1, 'and mounts the seat it names')
  for (const dispose of cleanups) dispose()
}

console.log('CLIENT SMOKE OK')
