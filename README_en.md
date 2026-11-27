# dsh-commit-plugin

[中文说明](README.md)

A DeepSeek Harness bundle that adds an IDEA-style **提交 / Commit** view beside
the conversation's 对话/轨迹 tabs: every uncommitted file of the Session's own
project, a per-file unified diff, checkbox selection, and a commit box that
commits only what you checked. The tab is session-scoped — each Session shows
its own repository, so there is no project picker on every open.

The tab appears only when the Session's workspace contains at least one git
repository: on first use the Host scans the workspace directory
(breadth-first, bounded: depth ≤ 4, ~800 directories, up to 60 projects,
dependency/build folders skipped), caches the answer per workspace for a
minute, and hides the tab whenever a finished scan found nothing. The footer's
**项目** selector lists exactly those discovered repositories — including every
independent sub-project of a multi-repository workspace such as `~/work`, so
each sub-project commits on its own.

It also exposes an optional `git_commit` agent tool. The agent's permission is
deployment configuration: `forbid`, `confirm` (default), or `allow`.

The toolbar mirrors the IDE commit view: rollback (discard selected changes),
show diff, group by directory, expand/collapse all, panel settings, and close.
It also opens with **update / push / remotes**, and the branch pill in the
header is a button: it drops the same branch popup the IDE's widget shows —
a search box, the commands above the list (Update Project, Fetch, Push, New
Branch, Checkout Tag or Revision, Remotes, Stash), then **本地 / 远程 / 标签**
groups. Hovering a branch row, moving onto it with the keyboard, or clicking it
hangs a second-level menu beside the list, exactly as the IDE does: checkout
(smart when the tree is dirty), new branch from it, merge it into the current
branch, rebase the current branch onto it, compare, update, push, tracking
branch, rename, delete.
Files split into **更改 / Changes** and **未进行版本管理的文件 / Unversioned
Files**; inside a group, a directory whose only child is another directory
collapses into one `src/client` row. The footer offers **提交** and **提交并推送**
(the push only runs after a successful commit, and creates the upstream the
first time there is none).

## Use

1. Open any Session whose workspace is a Git repository.
2. Open the **提交** tab: by default in the header row beside 对话/轨迹. To put it
   in the right sidebar instead — where the start page's **提交** capsule opens
   it — pick 右侧边栏 under 面板位置 on the plugin's own card (侧边栏 **插件** →
   **已安装** → **Git 提交**). The panel moves as soon as you choose, with no
   restart and no config edit. The tab is hidden while a workspace scan finds no
   repository.
3. The tab reads the bound Session's working directory automatically; use the
   **项目** selector only to point this tab at a different workspace directory.
4. Click a file row to expand its diff against `HEAD`; untracked files show an
   all-added diff. Drag the divider between the list and the diff to give either
   side more room; the two versions share a divider of their own.
5. The 当前版本 pane is editable in place: click into it and type. There is no
   edit mode to enter or leave — the diff colours, line numbers, and the
   alignment with the old version stay put, and the text is written back to
   the working tree shortly after you stop typing.
6. Check the files to commit, write a message, and press **提交选中文件**
   (or ⌘/Ctrl + Enter). Unchecked changes stay in the working tree.
7. A folder that is not a Git repository shows **没有未提交的改动** with an
   IDE-style **创建 Git 仓库** button: it runs `git init -b main`, writes a
   starter `.gitignore` (never overwriting an existing file), and immediately
   shows the new repository's uncommitted files.
8. **回滚** discards the checked files' uncommitted changes — tracked files are
   restored from `HEAD`, staged-but-uncommitted additions are removed, and
   untracked files are deleted. It asks for confirmation first; this cannot be
   undone.
9. The gear popover toggles auto-refresh and whether a freshly opened project
   starts with everything checked, and picks how **更新项目** pulls (merge,
   rebase, or fast-forward only).
10. The branch pill opens the branch popup. Everything there runs git directly
    and reports its output in the notice bar: **更新项目** pulls with the update
    method chosen in the popover, **抓取** fetches every remote, **推送** pushes
    the current branch and creates its upstream when it has none, **签出**
    switches branches, and a checkout with uncommitted work carries that work
    across with a stash and restores it.
11. **与 {ref} 比较**, reached from a branch row's submenu, opens a dialog with
    the commits each side holds on its own and the file differences between the
    two branches.
12. **管理远程** opens the IDE's remote table: every remote's name and URL, an
    add row, and a remove button. **确定** applies the whole table as ordered
    `git remote` calls (removes, renames, URL changes, then adds), and a new
    remote is fetched once so its branches appear at once. A row with no name
    or no URL stops the save with a note in the dialog, before git is called.
    Every saved http(s) row also carries a key button for its credentials, and
    when the fetch or set-url check finds the remote refuses an anonymous read,
    the dialog does not claim success: it opens a username + access token form
    instead. The token is handed to git's own credential helper (the Keychain on
    macOS) and the remote is asked again to confirm it now answers.
13. When a merge or rebase stops on conflicts the panel says so in a banner
    under the toolbar and offers **继续** / **中止**. Resolving means editing the
    conflicted files here and committing them like any other change.

The panel refreshes on open, on window focus, and every four seconds while it
is visible. A file written by the agent through `write`, `edit`, `apply_patch`,
or `str_replace_editor` in the current Session is marked **本会话修改**. The
commit-message draft is kept per project across panel switches and reloads.

Both dividers are dragged outside React: one mouse move writes one CSS variable
inside a `requestAnimationFrame` callback, React state is updated only when the
button is released, and the four-second poll pauses for the length of the drag.
A list of thousands of rows, or a diff of thousands of lines, follows the cursor
without stuttering.

Updating the plugin itself depends on which half changed. `client.js` is handed to
the page on every load, so a reload of the DSH window is enough. `index.js` is read
once when the Host process starts, so a new operation added there stays invisible
until DSH is restarted; the panel reports it as missing instead of guessing.

## Configuration

**Where the panel sits is a GUI setting.** The plugin's card in the 插件 panel
(侧边栏 **插件** → **已安装** → **Git 提交**) carries a **Git 提交面板** section: a
面板位置 switch between 对话顶部标签页 and 右侧边栏, plus a **恢复插件配置** button
that drops the override and falls back to the row Config below. The switch writes
into the active profile's patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`) as a
`config` block on the `git-commit` row, so it survives restarts, and every open
window follows it live: the Host commits the change into the running plugin's
configuration and the browser half re-mounts the panel in the other seat, with no
reload and no restart.

Everything else is deployment configuration in `cordis.patch.yml`, which this
bundle inserts with `placement: tab` and `agentCommit: confirm`:

```yaml
- id: git-commit
  name: 'dsh-commit-plugin'
  config:
    placement: tab
    agentCommit: confirm
```

Override it from the profile's own `cordis.patch.yml` with a row of the same
`id`; an override replaces the complete `config`.

| Field | Default | Meaning |
|---|---|---|
| `placement` | `tab` | Deployment default for the panel's location: `tab` adds it beside 对话/轨迹, `sidebar` puts it in DSH's right sidebar. Any other value keeps `tab`. A value picked in 插件 → 已安装 → Git 提交 → 面板位置 overrides this row live; the row alone applies where the plugin's configuration section is unavailable. `sidebar` needs a DSH build that has the right sidebar; on one that does not, neither source mounts anything. |
| `agentCommit` | `confirm` | `forbid` registers no `git_commit` tool; `confirm` routes every agent commit through DSH's approval prompt; `allow` commits directly. |
| `gitBinary` | `git` | Executable used for every git call. |
| `maxDiffChars` | `409600` | Largest diff returned to the panel; longer text is clipped with a truncation marker. |
| `initBranch` | `main` | Branch name the create-repository action starts on. |
| `initScaffold` | `true` | Write the starter `.gitignore` when creating a repository; existing files are never overwritten. |

The agent tool commits the Session's current working directory: `paths`
omitted means every uncommitted change; the message is required and blank
messages are rejected. It never pushes and never runs `git add -A` outside the
selected paths.

## Behavior details

- Git runs as an argv array (no shell string), from the repository root, with
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `GIT_EDITOR=true`.
- The status list is `git status --porcelain=v2 -z --untracked-files=all
  --branch`; per-file line stats come from `git diff --numstat -z` for the
  index and the working tree.
- A commit stages the selected paths, then runs `git commit -F - -- <paths>`.
  Files that were already staged but not selected stay staged. A file with both
  staged and unstaged changes is tagged **部分暂存** and is committed at its full
  working-tree state.
- An unresolved merge conflict is refused with `unresolved-conflict` instead of
  staging the conflict markers.
- The working-tree pane is one `contenteditable` body: a block per file line,
  with deleted-line and hunk rows kept as non-editable placeholders so the two
  columns stay aligned. Typing autosaves to the working tree ~800 ms after the
  last keystroke; switching file or project, and committing, flush first. A
  truncated preview (over 6000 rows) stays read-only.
- The HTTP surface is `POST /dsh-git-commit/api/<status|preview|diff|commit|
  discover|init|read|write|rollback|config|branches|fetch|pull|push|checkout|
  branch|merge|rebase|compare|tracking|stash|remotes|remote>` on DSH's own web
  server. Requests are same-origin (or loopback) only and JSON-only. Every
  branch and sync route answers with a fresh `status`, so the panel needs no
  extra round trip after it runs.
- The `remote` route probes every new or retargeted URL with
  `git ls-remote --heads` and answers `needsAuth` when git reports a blocked
  prompt, naming the row that needs it. A stored credential is written with
  `git credential approve`, and the secret exists only in git's stdin: not in a
  response, not in a log line, not in the repository configuration. Only
  http(s) remotes take one; an ssh URL is rejected as a bad request.
- The `config` route answers the `placement` the Host currently resolves, so a
  client that cannot reach the configuration form still mounts in the right seat.
- The URL prefix and the browser-side storage keys still read `dsh-git-commit`;
  they predate the name `dsh-commit-plugin`, and renaming them would silently
  drop saved preferences and per-project commit drafts.
- Non-repository directories and missing `git` produce empty states, not
  errors.

## Limitations

- Push, pull, and fetch run with whatever credentials the local git already has
  (a credential helper, an SSH agent, or the environment). https remotes can now
  be given a username and an access token from **管理远程**, which stores them
  through git's credential helper; ssh remotes stay the local git environment's
  job, and there is no SSH agent UI. There is no amend, cherry-pick, or history
  view.
- git never prompts for a password from inside the plugin: a remote that wants
  credentials you have not stored answers `needsAuth`, and the panel points at
  **管理远程** instead of failing quietly.
- Agent `bash` edits are not marked **本会话修改** (only the dedicated file tools
  are attributed).
- The panel reflects the working tree relative to `HEAD`. Conflicts are
  listed, and the banner offers to continue or abort the open operation; a
  conflicted file still has to be edited and checked before the panel commits.
- `git rev-parse @u` is not used to read the upstream: Apple's git resolves a
  bare `@u` as a path, so the upstream comes from `for-each-ref`
  `%(upstream:short)` instead.
- The project list comes from Session working directories; with no Session at
  all there is nothing to select until one is opened.

## Files

- `index.js` — Host half: git surface, same-origin API, `git_commit` tool, the
  `Config` schema whose `placement` field is volatile.
- `client.js` — Browser half: the panel, its copy, and the 面板位置 section.
- `cordis.patch.yml` — bundle row.
- `locale/{en,zh}.json` — Plugin Manager title and description.
- `README.md` / `README_en.md` — this documentation, in Chinese and English.
- `test/{smoke,client-smoke,render}.mjs` — `npm test`.

The Host half imports `@deepseek-ai/schemastery` for the `Config` schema, and the
`volatile()` marker needs at least 3.19.0, which the DSH desktop profile ships. An
installed copy resolves it from that profile's own `node_modules`; a checkout
linked in from elsewhere needs one there too, e.g. `mkdir -p node_modules/@deepseek-ai && ln -s ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/`.
The copy under `~/.dsh/profiles/node_modules` is 3.18.1 and has no `volatile()`.
