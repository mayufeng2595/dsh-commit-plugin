/**
 * Structural render test: extract the view's pure render helpers from
 * `client.js`, run them with a minimal `h()`, and assert on the resulting
 * element tree. This checks the layout the browser would draw without needing
 * a live page.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Slice one `function name(...) { ... }` declaration out of the source.
 * @param {string} name - function name.
 * @returns {string} the function source.
 */
function extractFunction(name) {
  const marker = `    function ${name}(`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `function ${name} not found in client.js`)
  // Skip the parameter list first: a destructured parameter contains braces.
  let parens = 0
  let bodyStart = -1
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') parens += 1
    else if (char === ')') {
      parens -= 1
      if (parens === 0) { bodyStart = source.indexOf('{', index); break }
    }
  }
  assert.ok(bodyStart >= 0, `cannot find the body of ${name}`)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unterminated function ${name}`)
}

/**
 * Build the sandbox that evaluates the extracted helpers.
 * @returns {object} scope with `h`, `React`, and the extracted functions.
 */
function loadHelpers() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) })
  const React = { Fragment: 'Fragment' }
  const names = [
    'statusLabel', 'statusCode', 'splitFiles', 'buildTree', 'pathParts', 'emptyState', 'PanelIcon', 'Chevron',
    'renderPreview', 'renderLines', 'hasWorkingTreeContent', 'renderBody', 'GitCommitSettingsCard',
    'BranchIcon', 'PullIcon', 'PushIcon', 'RemoteIcon', 'TagIcon', 'PlusIcon', 'MinusIcon',
    'matchesQuery', 'filterBranches', 'syncActions', 'branchActions', 'findBranch', 'submenuPlacement',
    'renderBranchSubmenu',
    'renderBranchPopup', 'diffRemotes',
    'renderBranchDialog',
    'errorText',
  ]
  const body = names.map(extractFunction).join('\n\n')
  const factory = new Function('h', 'React', 'CSS', `
// The panel's own hooks stay off-limits (a component test renders helpers, not
// the live view); the configuration section is rendered, so it gets inert ones.
const { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = {
  ...React,
  useCallback: fn => fn,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
// The glyph helper the icon functions share.
const icon = (paths, size) => h('svg', { width: size ?? 15, height: size ?? 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, ...paths)
${body}
return { ${names.join(', ')} }
`)
  return factory(h, React, '.dshgc-card{}')
}

const ui = loadHelpers()

/** Collect every node of one type in a rendered tree. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

/** Find host elements with one props shape. */
const elements = (tree, type) => collect(tree, node => node.type === type)

const t = key => key

/** One tracked file, one untracked file, mirroring the host's status payload. */
const files = [
  { path: 'src/app.ts', origPath: null, index: '.', worktree: 'M', kind: 'modified', additions: 2, deletions: 1, binary: false, touched: true },
  { path: 'docs/readme.md', origPath: null, index: '?', worktree: '?', kind: 'untracked', additions: 3, deletions: 0, binary: false, touched: false },
]
const selected = new Set(['src/app.ts'])
const trackedPreview = {
  path: 'src/app.ts',
  kind: 'text',
  untracked: false,
  additions: 1,
  deletions: 1,
  truncated: false,
  oldRef: '4f3a2c1',
  rows: [
    { type: 'hunk', text: '@@ -1,1 +1,2 @@' },
    { type: 'ctx', oldNo: 1, newNo: 1, oldText: 'one', newText: 'one' },
    { type: 'mod', oldNo: 2, newNo: 2, oldText: 'two', newText: 'TWO' },
    { type: 'add', newNo: 3, newText: 'three' },
  ],
}
const untrackedFilePreview = {
  path: 'docs/readme.md',
  kind: 'text',
  untracked: true,
  additions: 2,
  deletions: 0,
  truncated: false,
  oldRef: '4f3a2c1',
  rows: [{ type: 'add', newNo: 1, newText: '# Title' }, { type: 'add', newNo: 2, newText: '' }],
}

const baseView = {
  cwd: '/repo',
  data: { repo: { root: '/repo', branch: 'main' }, files },
  files,
  loadError: '',
  t,
  selected,
  toggleSelected: () => {},
  toggleSection: () => {},
  groupByDir: true,
  collapsedDirs: new Set(),
  collapsedSections: new Set(),
  toggleSectionCollapse: () => {},
  toggleDir: () => {},
  busy: false,
  retry: () => {},
  initRepository: () => {},
  selectedPath: 'src/app.ts',
  preview: trackedPreview,
  openPreview: () => {},
  splitRatio: 0.5,
  diffBoxRef: { current: null },
  leftPaneRef: { current: null },
  rightPaneRef: { current: null },
  startSplitDrag: () => {},
  syncPaneScroll: () => {},
  listWidth: null,
  splitRef: { current: null },
  startListDrag: () => {},
  saveState: 'idle',
  editBodyRef: { current: null },
  editGutterRef: { current: null },
  onEditInput: () => {},
}

// ---- 1. layout is a two-column split with the list on the left ----
const tree = ui.renderBody(baseView)
const split = elements(tree, 'div').filter(node => node.props.className === 'dshgc-split')
assert.equal(split.length, 1, 'body is one split container')
const listCol = elements(tree, 'div').filter(node => node.props.className === 'dshgc-listcol')
const previewCol = elements(tree, 'div').filter(node => node.props.className === 'dshgc-previewcol')
assert.equal(listCol.length, 1, 'left column holds the file list')
assert.equal(previewCol.length, 1, 'right column holds the preview')

// ---- 2. both section headers carry a select-all checkbox ----
const sectionChecks = elements(tree, 'input').filter(node => node.props.className === 'dshgc-section-check')
assert.equal(sectionChecks.length, 2, 'both groups have a select-all checkbox')
// The first section has 1 of 1 selected → checked; the unversioned one 0 of 1.
assert.equal(sectionChecks[0].props.checked, true)
assert.equal(sectionChecks[1].props.checked, false)
assert.equal(typeof sectionChecks[0].props.onChange, 'function', 'section checkbox toggles the whole group')

// A group folds like a tree node and hides its files.
const sectionToggles = elements(tree, 'button').filter(node => node.props.className === 'dshgc-section-toggle')
assert.equal(sectionToggles.length, 2, 'each group has a folding toggle')
assert.equal(sectionToggles[0].props['aria-expanded'], true)
assert.equal(typeof sectionToggles[0].props.onClick, 'function', 'the toggle folds the group')
const folded = ui.renderBody({ ...baseView, collapsedSections: new Set(['unversioned']) })
const foldedButtons = elements(folded, 'button').filter(node => node.props.className === 'dshgc-row-main')
assert.equal(foldedButtons.length, 1, 'a folded group hides every file beneath it')
const foldedToggles = elements(folded, 'button').filter(node => node.props.className === 'dshgc-section-toggle')
assert.equal(foldedToggles[1].props['aria-expanded'], false, 'the folded group reports its state')

// Folded groups still keep their own select-all checkbox reachable.
assert.equal(elements(folded, 'input').filter(node => node.props.className === 'dshgc-section-check').length, 2)

// ---- 3. row checkboxes are the only selection control ----
const rowChecks = elements(tree, 'input').filter(node => node.props.className === 'dshgc-row-check')
assert.equal(rowChecks.length, 2, 'one checkbox per file')
const rowButtons = elements(tree, 'button').filter(node => node.props.className === 'dshgc-row-main')
assert.equal(rowButtons.length, 2, 'one preview opener per file')
// Clicking the row must open the preview, never toggle selection.
assert.equal(rowButtons[0].props.onClick.toString().includes('toggleSelected'), false)

// ---- 4. the tracked preview is two independently scrollable versions ----
const diffBox = elements(tree, 'div').filter(node => node.props.className === 'dshgc-diff-box')
assert.equal(diffBox.length, 1, 'the versions sit in one fixed-width box')
const panes = elements(tree, 'div').filter(node => node.props.className === 'dshgc-pane')
assert.equal(panes.length, 2, 'one pane per version')
assert.ok(panes[0].props.style.flexBasis.endsWith('%'), 'the left pane carries the ratio')
assert.ok(panes[1].props.style.flexBasis.endsWith('%'), 'the right pane carries the rest')
const scrollers = elements(tree, 'div').filter(node => node.props.className === 'dshgc-pane-scroll')
assert.equal(scrollers.length, 2, 'each version owns a scroll area')
assert.equal(typeof scrollers[0].props.onScroll, 'function', 'vertical scrolling is mirrored between panes')

// Changed blocks get a tick on the scroll rail; clicking one jumps to it.
const rails = elements(tree, 'div').filter(node => node.props.className === 'dshgc-marks')
assert.equal(rails.length, 2, 'both versions carry a change rail')
assert.ok(rails[0].children.length >= 1, 'the previous version marks its changed blocks')
assert.ok(rails[1].children.length >= 1, 'the working tree marks its changed blocks')
assert.equal(typeof rails[0].children[0].props.onMouseDown, 'function', 'a tick jumps to its block')
assert.ok(String(rails[0].children[0].props.className).includes('dshgc-mark-del'))
assert.ok(String(rails[1].children[0].props.className).includes('dshgc-mark-add'))

// Each pane head names the version it shows.
const paneHeads = elements(tree, 'div').filter(node => node.props.className === 'dshgc-pane-head')
assert.equal(paneHeads.length, 2)
const titles = paneHeads.map(head => head.children[0].children[0])
assert.deepEqual(titles, ['preview.old', 'preview.new'])
const refs = paneHeads.map(head => head.children[1].children[0])
assert.equal(refs[0], 'HEAD 4f3a2c1', 'the left head names the baseline commit')
assert.equal(refs[1], 'preview.workingTree', 'the right head names the working tree')

// The divider is draggable.
const splitters = elements(tree, 'div').filter(node => node.props.className === 'dshgc-splitter')
assert.equal(splitters.length, 1, 'a draggable divider sits between the versions')
assert.equal(splitters[0].props.role, 'separator')
assert.equal(typeof splitters[0].props.onMouseDown, 'function')

// The file list has a divider of its own, between it and the diff.
const listSplit = elements(tree, 'div').filter(node => node.props.className === 'dshgc-splitter dshgc-list-split')
assert.equal(listSplit.length, 1, 'the list edge is draggable too')
assert.equal(listSplit[0].props.role, 'separator')
assert.equal(listSplit[0].props.title, 'list.resize')
assert.equal(typeof listSplit[0].props.onMouseDown, 'function')
// Order matters: the divider has to sit between the two columns it moves.
const splitChildren = split[0].children.map(node => node.props.className.split(' ')[0])
assert.deepEqual(splitChildren, ['dshgc-listcol', 'dshgc-splitter', 'dshgc-previewcol'])
assert.equal(split[0].props.style, null, 'an untouched list keeps the CSS width')
const sized = ui.renderBody({ ...baseView, listWidth: 320 })
assert.deepEqual(
  elements(sized, 'div').find(node => node.props.className === 'dshgc-split').props.style,
  { '--dshgc-list-width': '320px' },
  'a dragged list hands its width to the stylesheet',
)

// The previous version keeps the diff rows (with hunk markers); the working
// tree side is the editor.
const lines = elements(tree, 'div').filter(node => String(node.props.className).startsWith('dshgc-line'))
assert.ok(lines.length > 0, 'the previous version renders diff rows')
const leftLines = elements(scrollers[0], 'div')
  .filter(node => String(node.props.className).startsWith('dshgc-line'))
assert.deepEqual(leftLines.map(line => line.props.className), [
  'dshgc-line dshgc-line-hunk',
  'dshgc-line dshgc-line-ctx',
  'dshgc-line dshgc-line-del',
  'dshgc-line dshgc-line-void',
], 'the old side keeps hunk, context and deleted rows, with an empty slot for the added line')
const rightLines = elements(scrollers[1], 'div')
  .filter(node => String(node.props.className).startsWith('dshgc-editline'))
assert.equal(rightLines.length, leftLines.length, 'both versions render the same row count')
assert.ok(rightLines.some(line => line.props.className.includes('dshgc-editline-add')), 'the new side paints the added line')

// ---- 5. an untracked preview is one full-width pane, all added ----
const fullTree = ui.renderBody({ ...baseView, selectedPath: 'docs/readme.md', preview: untrackedFilePreview, selected: new Set() })
const fullPanes = elements(fullTree, 'div').filter(node => node.props.className === 'dshgc-pane dshgc-pane-single')
assert.equal(fullPanes.length, 1, 'an untracked file uses a single pane')
assert.equal(elements(fullTree, 'div').filter(node => node.props.className === 'dshgc-splitter').length, 0, 'no divider without two versions')
const fullLines = elements(fullTree, 'div').filter(node => String(node.props.className).includes('dshgc-editline-add'))
assert.ok(fullLines.length >= 2, 'every untracked line counts as added')

// ---- 6. no preview selected → the hint occupies the right column ----
const emptyTree = ui.renderBody({ ...baseView, selectedPath: '', preview: null })
const hint = elements(emptyTree, 'div').filter(node => node.props.className === 'dshgc-preview-empty')
assert.equal(hint.length, 1, 'an empty right pane explains itself')
assert.equal(hint[0].children[0], 'preview.hint')

// ---- 5b. a deleted file names the empty side instead of showing a blank column ----
const deletedPreview = {
  path: 'src/gone.java',
  kind: 'text',
  untracked: false,
  oldRef: '4f3a2c1',
  additions: 0,
  deletions: 2,
  truncated: false,
  rows: [
    { type: 'hunk', text: '@@ -1,2 +0,0 @@' },
    { type: 'del', oldNo: 1, oldText: 'one' },
    { type: 'del', oldNo: 2, oldText: 'two' },
  ],
}
const deletedTree = ui.renderBody({ ...baseView, selectedPath: 'src/gone.java', preview: deletedPreview })
const notes = elements(deletedTree, 'div').filter(node => node.props.className === 'dshgc-pane-note')
assert.equal(notes.length, 1, 'the working-tree column explains itself')
assert.equal(notes[0].children[0], 'preview.deleted', 'it says the file is deleted')
assert.equal(ui.hasWorkingTreeContent(deletedPreview.rows), false, 'a deleted file has no new lines')
assert.equal(ui.hasWorkingTreeContent(trackedPreview.rows), true, 'a modified file keeps new lines')

// ---- 5c. the working-tree side is always editable, styled as the diff ----
const bodies = elements(tree, 'div').filter(node => node.props.className === 'dshgc-editbody')
assert.equal(bodies.length, 1, 'the working tree is one editable body')
assert.equal(bodies[0].props.contentEditable, 'plaintext-only', 'typing works in place, with no edit mode')
assert.equal(typeof bodies[0].props.onInput, 'function', 'input feeds the gutter and the autosave')
assert.equal(elements(tree, 'textarea').length, 0, 'there is no separate editor control')
const blocks = elements(bodies[0], 'div').filter(node => String(node.props.className).startsWith('dshgc-editline'))
assert.equal(blocks.length, 4, 'every row keeps a block, so both columns stay aligned')
assert.equal(blocks.filter(node => node.props.contentEditable === false).length, 1, 'the hunk row stays a placeholder')
assert.ok(blocks.some(node => node.props.className.includes('dshgc-editline-add')), 'changed lines keep the added colour')
assert.ok(blocks.some(node => node.props.className.includes('dshgc-editline-ctx')), 'context lines keep their plain look')
const gutters = elements(tree, 'div').filter(node => node.props.className === 'dshgc-gutter')
assert.equal(gutters.length, 1, 'a gutter column carries the line numbers')
assert.equal(
  elements(tree, 'button').filter(node => String(node.props.className).startsWith('dshgc-pane-action')).length,
  0, 'no save or cancel buttons remain',
)

// A truncated preview must not be written back from a partial body.
const bigTree = ui.renderBody({ ...baseView, preview: { ...trackedPreview, truncated: true } })
const bigBody = elements(bigTree, 'div').filter(node => node.props.className === 'dshgc-editbody')[0]
assert.equal(bigBody.props.contentEditable, false, 'a truncated file stays read-only')

// An untracked file edits in the same body.
const untrackedTree = ui.renderBody({ ...baseView, selectedPath: 'docs/readme.md', preview: untrackedFilePreview, selected: new Set() })
assert.equal(
  elements(untrackedTree, 'div').filter(node => node.props.className === 'dshgc-editbody').length,
  1, 'an untracked file is editable too',
)

// A deleted file has nothing to edit.
assert.equal(elements(deletedTree, 'div').filter(node => node.props.className === 'dshgc-editbody').length, 0, 'a deleted file has no editor')

// ---- 6b. empty states fill the body so they centre themselves ----
const cleanTree = ui.renderBody({ ...baseView, files: [], data: { repo: { root: '/repo' }, files: [] } })
const cleanStates = elements(cleanTree, 'div').filter(node => node.props.className === 'dshgc-empty')
assert.equal(cleanStates.length, 1, 'a clean tree renders one empty state')
assert.equal(cleanTree, cleanStates[0], 'the empty state is the whole body, not a column inside it')
assert.equal(typeof cleanStates[0].children[0], 'object', 'it still carries its icon and copy')

// ---- 7. a directory without files in a group renders no section ----
const single = ui.renderBody({ ...baseView, files: [files[0]], data: { repo: { root: '/repo' }, files: [files[0]] } })
assert.equal(elements(single, 'input').filter(node => node.props.className === 'dshgc-section-check').length, 1, 'only the non-empty group renders')

// ---- 8. the section is the plugin's own control on its 插件 detail page ----
/**
 * A form serving one snapshot, recording what the section asked to write.
 * @param {object} snapshot - the configuration snapshot to publish.
 * @returns {object} the fake form.
 */
function cardScope(snapshot) {
  const writes = []
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => { writes.push([field, value]) },
    unset: async (field) => { writes.push([field]) },
  }
}

const overriddenScope = cardScope({
  status: 'ready',
  value: { placement: 'sidebar' },
  base: { placement: 'tab' },
  user: { placement: 'sidebar' },
  writable: true,
})
const cardTree = ui.GitCommitSettingsCard({ t, configForm: overriddenScope })
assert.equal(cardTree.type, 'div', 'the section is one block of the bundle page')
assert.ok(elements(cardTree, 'style').length === 1, 'the card carries its own sheet')
const radios = elements(cardTree, 'button').filter(node => node.props.role === 'radio')
assert.equal(radios.length, 2, 'exactly the two seats are offered')
assert.equal(radios.filter(node => node.props['aria-checked'] === true).length, 1, 'one seat reads as chosen')
assert.equal(radios[1].props['aria-checked'], true, 'the setting says sidebar')
assert.ok(radios[1].props.className.includes('dshgc-seg-btn-on'), 'and the control shows it')
assert.equal(radios.some(node => node.props.disabled), false, 'a writable document leaves the choice open')
assert.equal(
  elements(cardTree, 'button').filter(node => node.props.className === 'dshgc-card-reset').length,
  1, 'an override offers the way back to the row Config',
)
radios[0].props.onClick()
assert.deepEqual(overriddenScope.writes, [['placement', 'tab']], 'the other seat is written by name')
const resets = elements(cardTree, 'button').filter(node => node.props.className === 'dshgc-card-reset')
resets[0].props.onClick()
assert.deepEqual(overriddenScope.writes[1], ['placement'], 'resetting clears the override')

const plainScope = cardScope({ status: 'ready', value: { placement: 'tab' }, base: { placement: 'tab' }, user: {}, writable: true })
const plainTree = ui.GitCommitSettingsCard({ t, configForm: plainScope })
assert.equal(
  elements(plainTree, 'button').filter(node => node.props.className === 'dshgc-card-reset').length,
  0, 'following the deployment needs no reset',
)
plainScope.writes.length = 0
elements(plainTree, 'button').find(node => node.props.role === 'radio' && node.props['aria-checked'] === true).props.onClick()
assert.deepEqual(plainScope.writes, [], 'choosing the seat already in place writes nothing')

assert.equal(
  ui.GitCommitSettingsCard({ t, configForm: cardScope({ status: 'unavailable', writable: false }) }),
  null, 'an entry this client cannot configure leaves no trace',
)
const readOnly = ui.GitCommitSettingsCard({
  t,
  configForm: cardScope({ status: 'ready', value: { placement: 'tab' }, base: {}, user: {}, writable: false }),
})
assert.ok(readOnly !== null, 'a read-only document still shows where the panel sits')
assert.equal(elements(readOnly, 'button').filter(node => node.props.role === 'radio').every(node => node.props.disabled), true, 'but nothing can be changed')

/* ------------------------------------------------------------------ *
 * The branch popup: IDEA's operations, folded into the commit panel.
 * ------------------------------------------------------------------ */
const branchTable = {
  root: '/repo/one',
  current: 'main',
  detached: false,
  upstream: 'origin/main',
  state: null,
  dirty: true,
  remotes: ['origin'],
  stash: 1,
  local: [
    { name: 'main', upstream: 'origin/main', ahead: 2, behind: 0, gone: false, subject: 'init', current: true },
    { name: 'feature', upstream: '', ahead: 0, behind: 3, gone: false, subject: 'work', current: false },
  ],
  remote: [{ name: 'origin/develop', remote: 'origin', branch: 'develop', oid: 'abc1234', subject: 'dev', current: false }],
  tags: [{ name: 'v1.0.0', remote: '', branch: '', oid: 'def4567', subject: 'release' }],
}
const ids = rows => rows.map(row => row.id)

// What one branch row offers depends on where it sits relative to HEAD.
const onMain = ui.branchActions({ ...branchTable.local[0], kind: 'local' }, branchTable, t)
assert.deepEqual(ids(onMain), ['newFrom', 'update', 'push', 'tracking', 'compare'])
const onFeature = ui.branchActions({ ...branchTable.local[1], kind: 'local' }, branchTable, t)
assert.deepEqual(ids(onFeature), ['checkout', 'newFrom', 'merge', 'rebase', 'rename', 'delete', 'compare'])
assert.equal(onFeature.find(row => row.id === 'delete').danger, true, 'only the delete asks for a warning')
// A dirty tree makes the plain checkout the smart one, as IDEA does.
assert.equal(onFeature.find(row => row.id === 'checkout').label, 'branch.checkoutSmart')
const onRemote = ui.branchActions({ ...branchTable.remote[0], kind: 'remote' }, branchTable, t)
assert.deepEqual(ids(onRemote), ['checkout', 'compare', 'merge', 'trackAs'])
const onTag = ui.branchActions({ ...branchTable.tags[0], kind: 'tag' }, branchTable, t)
assert.deepEqual(ids(onTag), ['checkout', 'compare', 'merge'], 'a tag is not something to track')
const detached = { ...branchTable, current: '', detached: true }
assert.deepEqual(
  ids(ui.branchActions({ ...branchTable.local[1], kind: 'local' }, detached, t)),
  ['checkout', 'newFrom', 'compare'],
  'a detached HEAD only moves somewhere else',
)

const commands = ui.syncActions(branchTable, t)
assert.deepEqual(
  ids(commands),
  ['update', 'fetch', 'push', 'newBranch', 'checkoutRev', 'remotes', 'stash', 'stashPop'],
  'the stash rows appear only when there is something to stash or restore',
)
assert.deepEqual(
  ids(ui.syncActions({ ...branchTable, dirty: false, stash: 0 }, t)),
  ['update', 'fetch', 'push', 'newBranch', 'checkoutRev', 'remotes'],
)
assert.deepEqual(ui.syncActions(null, t).length, 6, 'a table that has not loaded still shows the commands')

const filtered = ui.filterBranches(branchTable, 'DEV')
assert.deepEqual(filtered.local, [], 'nothing local matches')
assert.deepEqual(filtered.remote.map(row => row.name), ['origin/develop'])
assert.deepEqual(ui.filterBranches(branchTable, '').tags.map(row => row.name), ['v1.0.0'])

const popupCalls = []
const popup = ui.renderBranchPopup({
  t,
  data: branchTable,
  loading: false,
  query: '',
  expanded: 'local:feature',
  busy: false,
  onQuery: value => popupCalls.push(['query', value]),
  onToggle: key => popupCalls.push(['toggle', key]),
  onAction: (action, branch) => popupCalls.push([action.id, branch === null ? null : branch.name]),
})
assert.equal(popup.props.role, 'dialog', 'the popup is a dialog of its own')
assert.equal(elements(popup, 'input').length, 1, 'and opens with its search box')
const groupTitles = elements(popup, 'div').filter(node => node.props.className === 'dshgc-branch-title').map(node => node.children[0])
assert.deepEqual(groupTitles, ['branch.local', 'branch.remote', 'branch.tags'])
const branchRows = elements(popup, 'button').filter(node => node.props.className?.startsWith('dshgc-branch-row'))
assert.equal(branchRows.length, 4, 'two local, one remote, one tag')
assert.ok(branchRows.some(node => node.props.className === 'dshgc-branch-row dshgc-branch-row-on'), 'the current branch is marked')
// IDEA keeps the list clean and hangs the row's operations in a second menu.
assert.equal(elements(popup, 'button').filter(node => node.props.className?.includes('dshgc-branch-op') && !node.props.className.includes('dshgc-branch-command')).length, 0, 'no operation is folded into the list')
assert.equal(branchRows.find(node => node.props['aria-expanded'] === true).props.className, 'dshgc-branch-row dshgc-branch-row-open', 'the active row stays marked out')
assert.equal(elements(popup, 'button').filter(node => node.props['aria-expanded'] === true).length, 1)
branchRows[0].props.onClick()
assert.deepEqual(popupCalls[0], ['toggle', 'local:main'], 'a row takes over the submenu')
branchRows[2].props.onMouseEnter()
assert.deepEqual(popupCalls[1], ['toggle', 'remote:origin/develop'], 'hovering is enough to reach a row')
elements(popup, 'button')
  .find(node => node.props.className === 'dshgc-branch-op dshgc-branch-command' && node.children[0] === 'sync.push')
  .props.onClick()
assert.deepEqual(popupCalls[2], ['push', null], 'a command row carries no branch')

// The submenu is the second level of the same popup, driven by the active key.
const submenuCalls = []
const activeBranch = ui.findBranch(branchTable, '', 'local:feature')
assert.deepEqual([activeBranch.name, activeBranch.kind], ['feature', 'local'], 'the key names one row')
const submenu = ui.renderBranchSubmenu({
  t,
  branch: activeBranch,
  data: branchTable,
  busy: false,
  onAction: (action, branch) => submenuCalls.push([action.id, branch.name]),
})
assert.equal(submenu.props.role, 'menu', 'and reads as a menu to the screen reader')
assert.equal(submenu.props['aria-label'], 'feature', 'named after the branch it acts on')
const submenuRows = elements(submenu, 'button')
assert.deepEqual(
  submenuRows.map(node => node.children[0]),
  ['branch.checkoutSmart', 'branch.newFrom', 'branch.merge', 'branch.rebase', 'branch.rename', 'branch.delete', 'branch.compare'],
  'the row offers the same operations as before, one level deeper',
)
submenuRows[0].props.onClick()
assert.deepEqual(submenuCalls[0], ['checkout', 'feature'], 'clicking one runs it for that branch')
assert.equal(ui.findBranch(branchTable, 'zzz', 'local:feature'), null, 'a row filtered out of the list has no submenu')
assert.equal(ui.findBranch(branchTable, '', ''), null, 'no key, no row')
assert.equal(ui.findBranch(null, '', 'local:feature'), null, 'nor before the table has loaded')
assert.equal(ui.renderBranchSubmenu({ t, branch: null, data: branchTable, busy: false, onAction: () => {} }), null)
assert.equal(ui.renderBranchSubmenu({ t, branch: activeBranch, data: null, busy: false, onAction: () => {} }), null)

// The menu belongs beside the row it came from, and never leaves the panel.
const panel = { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 }
const list = { left: 14, top: 44, right: 474, bottom: 484, width: 460, height: 440 }
assert.deepEqual(
  ui.submenuPlacement(panel, list, { left: 14, top: 100, right: 474, bottom: 124 }, { width: 240, height: 180 }),
  { left: 480, top: 100 },
  'a roomy panel hangs the menu to the right of the list',
)
assert.deepEqual(
  ui.submenuPlacement({ ...panel, right: 400, width: 400 }, { ...list, right: 372, width: 358 }, { left: 14, top: 100, right: 372, bottom: 124 }, { width: 240, height: 180 }),
  { left: 126, top: 100 },
  'a narrow one lets it cover the list instead of the panel edge',
)
assert.deepEqual(
  ui.submenuPlacement(panel, list, { left: 14, top: 450, right: 474, bottom: 474 }, { width: 240, height: 180 }),
  { left: 480, top: 296 },
  'the last row pulls the menu back inside the list',
)

// An empty search says so instead of drawing an empty table.
const emptyPopup = ui.renderBranchPopup({
  t, data: branchTable, loading: false, query: 'zzz', expanded: '', busy: false,
  onQuery: () => {}, onToggle: () => {}, onAction: () => {},
})
assert.ok(JSON.stringify(emptyPopup).includes('branch.empty'), 'no match is stated plainly')

// The remote table turns into git calls in a safe order.
const original = [{ name: 'origin', url: 'https://a/one' }, { name: 'old', url: 'https://a/two' }]
assert.deepEqual(ui.diffRemotes(original, original.map(row => ({ ...row, originName: row.name }))), [], 'an untouched table sends nothing')
assert.deepEqual(ui.diffRemotes(original, [
  { name: 'origin', url: 'https://a/changed', originName: 'origin' },
  { name: 'old', url: 'https://a/two', originName: 'old' },
]), [{ action: 'set-url', name: 'origin', url: 'https://a/changed' }])
assert.deepEqual(ui.diffRemotes(original, [
  { name: 'origin', url: 'https://a/one', originName: 'origin' },
  { name: 'upstream', url: 'https://a/two', originName: 'old' },
  { name: 'new', url: 'https://a/three', originName: '' },
]), [
  { action: 'rename', name: 'old', newName: 'upstream' },
  { action: 'add', name: 'new', url: 'https://a/three' },
], 'the rename keeps the URL it already had')
assert.deepEqual(ui.diffRemotes(original, [
  { name: 'gone', url: 'https://a/moved', originName: 'origin' },
  { name: 'old', url: 'https://a/two', originName: 'old' },
]), [
  { action: 'rename', name: 'origin', newName: 'gone' },
  { action: 'set-url', name: 'gone', url: 'https://a/moved' },
], 'a rename that also moves the URL is two calls, in order')
assert.deepEqual(ui.diffRemotes(original, []), [
  { action: 'remove', name: 'origin' },
  { action: 'remove', name: 'old' },
])

const dialogCalls = []
const remoteDialog = ui.renderBranchDialog({
  t,
  busy: false,
  dialog: {
    kind: 'remotes',
    title: 'Git Remotes',
    loading: false,
    error: '',
    original,
    rows: [{ name: 'origin', url: 'https://a/one', originName: 'origin' }, { name: '', url: '', originName: '' }],
  },
  onField: (field, value) => dialogCalls.push(['field', field, value]),
  onRow: (index, field, value) => dialogCalls.push(['row', index, field, value]),
  onSubmit: () => dialogCalls.push(['submit']),
  onCancel: () => dialogCalls.push(['cancel']),
})
const remoteInputs = elements(remoteDialog, 'input')
assert.equal(remoteInputs.length, 4, 'every row edits its name and its URL')
assert.equal(remoteInputs[0].props.disabled, false, 'an existing remote can be renamed in place')
assert.equal(remoteInputs[2].props.disabled, false, 'the new row types its own name')
elements(remoteDialog, 'button').find(node => node.props['aria-label'] === 'remote.remove').props.onClick()
assert.deepEqual(dialogCalls[0], ['row', 0, 'remove', ''])
remoteDialog.props.onClick()
assert.deepEqual(dialogCalls.at(-1), ['cancel'], 'clicking past the card closes it')

// A table that failed to load must not also claim the repository has no remote.
const failedRemoteDialog = ui.renderBranchDialog({
  t,
  busy: false,
  dialog: { kind: 'remotes', title: 'Git Remotes', loading: false, error: 'unknown method "remotes"', rows: [], original: [] },
  onField: () => {}, onRow: () => {}, onSubmit: () => {}, onCancel: () => {},
})
const failedRemoteText = JSON.stringify(failedRemoteDialog)
assert.ok(failedRemoteText.includes('unknown method'), 'the error is shown')
assert.ok(!failedRemoteText.includes('remote.none'), 'and the empty table is not described as having no remotes')
assert.equal(elements(failedRemoteDialog, 'button').find(node => node.props.className === 'dshgc-primary').props.disabled, false,
  'the dialog still closes on its own buttons')

// A route the running Host does not know is a stale host, and says so.
const stale = new Error('unknown method "pull"')
stale.code = 'not-found'
assert.equal(ui.errorText(t, stale), 'op.stale')
assert.equal(ui.errorText(t, new Error('git failed')), 'git failed')
assert.equal(ui.errorText(t, 'plain'), 'plain')

const compareDialog = ui.renderBranchDialog({
  t,
  busy: false,
  dialog: {
    kind: 'compare',
    title: 'feature against main',
    loading: false,
    error: '',
    data: {
      base: 'main', ref: 'feature', ahead: 1, behind: 0,
      files: [{ status: 'M', path: 'src/a.ts', origPath: null }, { status: 'R', path: 'src/b.ts', origPath: 'src/old.ts' }],
      aheadCommits: [{ hash: 'abc1234', author: 'Test', date: '2026-11-27', subject: 'work' }],
      behindCommits: [],
    },
  },
  onField: () => {}, onRow: () => {}, onSubmit: () => {}, onCancel: () => {},
})
const compareText = JSON.stringify(compareDialog)
assert.ok(compareText.includes('compare.ahead'), 'the count line is there')
assert.ok(!compareText.includes('compare.behind'), 'and the side with nothing does not claim anything')
assert.ok(compareText.includes('src/old.ts'), 'a rename shows both names')
assert.equal(elements(compareDialog, 'span').filter(node => node.props.className === 'dshgc-code dshgc-code-renamed').length, 1)

const promptCalls = []
const promptDialog = ui.renderBranchDialog({
  t,
  busy: false,
  dialog: { kind: 'prompt', title: 'New Branch', label: 'Branch name', value: '', method: 'branch', field: 'name', extra: { action: 'create' } },
  onField: (field, value) => promptCalls.push([field, value]),
  onRow: () => {},
  onSubmit: () => promptCalls.push(['submit']),
  onCancel: () => {},
})
const promptInput = elements(promptDialog, 'input')[0]
promptInput.props.onChange({ target: { value: 'next' } })
assert.deepEqual(promptCalls[0], ['value', 'next'])
const promptConfirm = elements(promptDialog, 'button').find(node => node.props.className === 'dshgc-primary')
assert.equal(promptConfirm.props.disabled, true, 'an empty name cannot be submitted')
promptInput.props.onKeyDown({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => promptCalls.push(['stopped']) })
assert.deepEqual(promptCalls.slice(1), [['stopped'], ['submit']], 'Enter submits once, and never reaches the panel handler')

assert.equal(ui.renderBranchDialog({ t, dialog: null, busy: false, onField: () => {}, onRow: () => {}, onSubmit: () => {}, onCancel: () => {} }), null)

// Every label the view asks for has to exist in both dictionaries, or an
// English panel would fall back to Chinese text (or to the raw key).
{
  const block = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    assert.ok(start >= 0, `${name} dictionary is missing`)
    let depth = 0
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, index)
      }
    }
    throw new Error(`unterminated ${name} dictionary`)
  }
  const keysOf = (text) => [...text.matchAll(/^\s+'([a-zA-Z0-9._-]+)':/gm)].map(match => match[1])
  const zhKeys = keysOf(block('zh'))
  const enKeys = keysOf(block('en'))
  assert.deepEqual(zhKeys.filter(key => !enKeys.includes(key)), [], 'the English dictionary is missing keys')
  assert.deepEqual(enKeys.filter(key => !zhKeys.includes(key)), [], 'the Chinese dictionary is missing keys')
  assert.equal(new Set(zhKeys).size, zhKeys.length, 'a key is declared twice')
  // Some keys reach `t()` through a table or a template string, so scan the
  // whole source for anything shaped like a key and insist it is declared.
  // The known prefixes come from the dictionaries themselves.
  const families = new Set(zhKeys.map(key => key.split('.')[0]))
  const mentioned = [...new Set([...source.matchAll(/'([a-z][a-z0-9]*(?:\.[a-zA-Z0-9_-]+)+)'/g)]
    .map(match => match[1])
    .filter(key => families.has(key.split('.')[0])))]
  assert.ok(mentioned.includes('toolbar.remotes'), 'the key scan found nothing to check')
  for (const key of mentioned) {
    assert.ok(zhKeys.includes(key), `zh is missing "${key}"`)
    assert.ok(enKeys.includes(key), `en is missing "${key}"`)
  }
}

console.log('RENDER OK')
