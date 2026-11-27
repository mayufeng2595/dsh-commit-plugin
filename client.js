/**
 * dsh-git-commit — browser half.
 *
 * One global sidebar panel ("改动" / "Changes"): the project's uncommitted
 * changes, a per-file unified diff, selective checkboxes, and a commit box.
 * It reads the same Session catalog the host uses, so the panel follows the
 * session shown in the main view and remembers the last project when the
 * conversation is hidden by the panel itself.
 *
 * The panel talks to the Host half at a mount-relative `dsh-git-commit/api/`
 * path, so a sub-path proxy keeps working.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-git-commit',
  factory(require) {
    const React = require('react')
    const { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const NS = 'gitCommit'
    const API_BASE = 'dsh-git-commit/api/'
    const POLL_MS = 4000
    const MAX_RENDERED_DIFF_LINES = 4000

    /** This plugin's seat identity, reused as the conversation view id, the
     *  right-sidebar tab type id/kind, and the sidebar tab body's slot key. */
    const VIEW_ID = 'git-commit'
    /** The profile entry id this plugin runs under. The Host settings service
     *  keys every configuration form by entry id, so this names both the form
     *  this half edits and the `placement` field inside it. */
    const ENTRY_ID = 'git-commit'
    /** This bundle's package name: the key the 插件 page looks its own
     *  configuration section up by (`plugins.bundle.config`). */
    const BUNDLE_PKG = '@local/dsh-git-commit'
    /** Below this panel width the file list and the diff stack instead of sharing a row. */
    const NARROW_PX = 640
    /** Reads one Session's working directory; replaced when the sessions service mounts. */
    let cwdOfSession = () => ''
    /** Scan answers per workspace root: { value: { repos, truncated } | undefined }. */
    const discoveryRecords = new Map()
    /** Listeners notified when any scan answer lands. */
    const discoveryListeners = new Set()
    /** Mounted conversation views, notified when any scan answer changes. */
    const viewWakeups = new Set()
    /** Session id -> Workspace directory, rebuilt from the Workspace registry. */
    const sessionWorkspace = new Map()
    /** Sessions service captured at registration; reads the on-screen Session. */
    let sessionsServiceRef = null
    /** Latest Workspace rows kept current by the injected service. */
    let workspaceRowsRef = []
    /** Components waiting for a Workspace roster refresh. */
    const workspaceRowsListeners = new Set()

    /**
     * Replace the cached Workspace rows and wake readers.
     * @param {Array<object>} items - Workspace rows.
     */
    function setWorkspaceRows(items) {
      workspaceRowsRef = Array.isArray(items) ? items : []
      for (const listener of [...workspaceRowsListeners]) listener()
    }

    /**
     * The Session the main view retains (the conversation on screen).
     * @returns {string | undefined} its id, or undefined while none is shown.
     */
    function activeSessionId() {
      try {
        const sessions = sessionsServiceRef
        if (sessions === null || sessions === undefined) return undefined
        const list = sessions.list?.getSnapshot?.()
        if (list === null || list === undefined) return undefined
        const ids = Array.isArray(list.ids) ? list.ids : Object.keys(list.byId ?? {})
        let best = null
        for (const id of ids) {
          const row = list.byId?.[id]
          if (row === null || row === undefined || typeof row.cwd !== 'string') continue
          let main = 0
          try {
            const info = sessions.retainInfo?.(id)
            const snapshot = info?.getSnapshot?.()
            main = typeof snapshot?.retainedBy?.mainView === 'number' ? snapshot.retainedBy.mainView : 0
          } catch {
            main = 0
          }
          if (main <= 0) continue
          if (best === null || (row.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = row
        }
        return best === null ? undefined : best.id
      } catch {
        return undefined
      }
    }

    /**
     * Rebuild the Session -> Workspace map from one registry snapshot.
     * @param {Array<object>} items - Workspace rows with path and sessionIds.
     */
    function indexWorkspaces(items) {
      sessionWorkspace.clear()
      for (const item of items) {
        for (const sessionId of item.sessionIds ?? []) sessionWorkspace.set(sessionId, item.path)
      }
      setWorkspaceRows(items)
      // Mounted bodies read their scan root through this map; wake them so a
      // late membership answer re-runs discovery and project selection.
      for (const wake of [...viewWakeups]) wake()
    }

    /**
     * The workspace root a Session belongs to.
     * @param {string} sessionId - Session identity.
     * @returns {string | undefined} scan root.
     */
    function workspaceRootOfSession(sessionId) {
      return sessionWorkspace.get(sessionId)
    }

    /**
     * Ask the Host to scan one workspace and publish the answer.
     * @param {string} root - workspace directory.
     * @param {boolean} refresh - force a rescan past the Host cache.
     * @returns {Promise<void>} completion.
     */
    async function discoverWorkspace(root, refresh) {
      try {
        const result = await api('discover', { cwd: root, refresh })
        const record = discoveryRecords.get(root) ?? {}
        record.value = result
        discoveryRecords.set(root, record)
      } catch {
        // A failed scan leaves the tab hidden rather than erroring loudly.
        const record = discoveryRecords.get(root)
        if (record !== undefined && record.value === undefined) record.value = { repos: [], truncated: false }
        else if (record === undefined) discoveryRecords.set(root, { value: { repos: [], truncated: false } })
      }
      for (const listener of [...discoveryListeners]) listener()
      for (const wake of [...viewWakeups]) wake()
    }

    /**
     * Read one workspace's scan as a subscribable snapshot source. The first
     * read starts the scan; later reads share its result.
     * @param {string} root - workspace directory.
     * @returns {{ getSnapshot: () => object | undefined, subscribe: (l: () => void) => () => void }} source.
     */
    function discoverySource(root) {
      let record = discoveryRecords.get(root)
      if (record === undefined) {
        record = { value: undefined }
        discoveryRecords.set(root, record)
        void discoverWorkspace(root, false)
      }
      return {
        getSnapshot: () => record.value,
        subscribe: listener => {
          discoveryListeners.add(listener)
          return () => discoveryListeners.delete(listener)
        },
      }
    }

    /**
     * Whether the guide entry should show for the Session on screen: false
     * only while a finished scan found no repository in its workspace.
     * @returns {boolean} visibility.
     */

    /**
     * Register one mounted view body so a fresh scan result re-renders it.
     * @param {function} wake - re-render callback.
     * @returns {function} unsubscriber.
     */
    function subscribeViewWakeup(wake) {
      viewWakeups.add(wake)
      return () => viewWakeups.delete(wake)
    }



    const zh = {
      'panel.title': '提交',
      'guide.sidebar': '查看并提交当前项目的未提交改动',
      'card.title': 'Git 提交面板',
      'card.description': '查看当前项目的未提交改动并按文件提交。',
      'card.placement': '面板位置',
      'card.placementHint': '改动立即生效，无需重启或刷新。',
      'card.placement.tab': '对话顶部标签页',
      'card.placement.sidebar': '右侧边栏',
      'card.reset': '恢复插件配置',
      'card.readOnly': '此连接为只读，无法修改插件配置。',
      'header.files': '{count} 个文件',
      'header.refresh': '刷新改动',
      'toolbar.label': '操作',
      'toolbar.rollback': '回滚选中的改动',
      'toolbar.showDiff': '显示所选文件的差异',
      'toolbar.group': '按目录分组',
      'toolbar.expandAll': '展开全部',
      'toolbar.collapseAll': '折叠全部',
      'toolbar.settings': '面板设置',
      'toolbar.close': '关闭并返回对话',
      'settings.title': '面板设置',
      'settings.autoRefresh': '自动刷新（4 秒）',
      'settings.selectByDefault': '打开项目时默认全选',
      'settings.update': '更新方式',
      'settings.update.merge': '合并',
      'settings.update.rebase': '变基',
      'settings.update.ffOnly': '仅快进',
      'header.project': '项目',
      'header.branch': '当前分支',
      'header.changes': '当前变动',
      'header.searching': '正在查找 Git 项目…',
      'header.noRepos': '工作区内没有 Git 项目',
      'header.truncated': '（项目过多，未全部列出）',
      'empty.noProject.title': '还没有可用的项目',
      'empty.noProject.body': '当前会话没有工作目录。在会话里设置工作目录后，其项目改动会自动出现在这里。',
      'empty.gitMissing.title': '找不到可用的 git',
      'empty.gitMissing.body': '请确认已安装 git，或把插件配置文件里的 gitBinary 指向 git 可执行文件。',
      'empty.clean.title': '没有未提交的改动',
      'empty.clean.body': '工作区是干净的。Agent 修改文件后，这里会自动出现新的改动。',
      'empty.noRepo.title': '没有未提交的改动',
      'empty.noRepo.body': '当前项目还不是 Git 仓库。初始化后即可查看改动并提交。',
      'empty.noRepo.init': '创建 Git 仓库',
      'empty.noRepo.initializing': '正在初始化…',
      'empty.noRepo.done': '已创建 Git 仓库，现在可以查看并提交改动。',
      'empty.noRepo.doneFiles': '已创建 Git 仓库，并生成 {files}，现在可以查看并提交改动。',
      'error.load': '读取改动失败：{message}',
      'empty.loadError.title': '读取改动失败',
      'empty.retry': '重试',
      'error.commit': '提交失败：{message}',
      'error.rollback': '回滚失败：{message}',
      'rollback.title': '回滚这些改动？',
      'rollback.body': '将丢弃 {count} 个文件的未提交改动（包括已暂存内容），并删除未跟踪文件。此操作不可撤销。',
      'rollback.confirm': '回滚',
      'rollback.cancel': '取消',
      'notice.rolledBack': '已回滚 {count} 个文件的改动',
      'section.changes': '更改',
      'section.unversioned': '未进行版本管理的文件',
      'commit.push': '提交并推送',
      'pushing': '正在提交并推送…',
      'notice.pushFailed': '已提交 {hash}，但推送失败：{message}',
      'notice.committedPushed': '已提交 {hash} · {subject}，并已推送',
      'notice.noFiles': '先勾选要提交的文件。',
      'notice.needMessage': '请填写提交信息。',
      'notice.committed': '已提交 {hash} · {subject}',
      'list.all': '全选',
      'list.selectAll': '全选改动',
      'list.unselectAll': '取消全选',
      'list.touched': '本会话修改',
      'list.partial': '部分暂存',
      'list.partialHint': '这个文件同时有已暂存和未暂存的改动，提交时会包含全部未暂存内容。',
      'commit.placeholder': '提交信息（必填）',
      'commit.submit': '提交选中文件',
      'commit.submitting': '正在提交…',
      'commit.hint': '只提交勾选的文件；未勾选的改动会保留在工作区。⌘/Ctrl + Enter 提交。',
      'commit.count': '已选 {count} / {total}',
      'preview.hint': '在左侧点击一个文件，这里会显示它的变更内容。',
      'preview.old': '旧版本',
      'preview.new': '当前版本',
      'preview.workingTree': '工作区',
      'preview.untrackedFile': '工作区 · 新文件',
      'preview.noBase': '尚无提交（空）',
      'preview.deleted': '文件已删除',
      'edit.saving': '保存中…',
      'edit.area': '编辑当前版本内容',
      'edit.saved': '已保存到工作区',
      'error.write': '无法保存文件：{message}',
      'preview.resize': '拖动调整两侧宽度',
      'list.resize': '拖动调整列表宽度',
      'diff.binary': '二进制文件，无法预览文本 diff。',
      'diff.tooLarge': '文件太大，无法在侧栏预览。',
      'diff.truncated': 'diff 已截断',
      'status.modified': '已修改',
      'status.added': '新增',
      'status.deleted': '已删除',
      'status.renamed': '重命名',
      'status.untracked': '未跟踪',
      'status.conflict': '冲突',
      'branch.detached': '游离 HEAD',
      'branch.ahead': '领先 {count}',
      'branch.behind': '落后 {count}',
      'toolbar.update': '更新项目（拉取）',
      'toolbar.push': '推送到远端',
      'toolbar.remotes': '管理远程仓库',
      'branch.button': '分支与操作',
      'branch.menu': '分支和操作',
      'branch.search': '搜索分支和操作',
      'branch.loading': '正在读取分支…',
      'branch.empty': '没有匹配的分支',
      'branch.local': '本地',
      'branch.remote': '远程',
      'branch.tags': '标签',
      'branch.current': '当前',
      'branch.gone': '远端已删除',
      'branch.new': '新建分支…',
      'branch.newFrom': '从 {ref} 新建分支…',
      'branch.checkoutRev': '签出标记或修订…',
      'branch.checkout': '签出',
      'branch.checkoutSmart': '智能签出（带走未提交改动）',
      'branch.update': '更新',
      'branch.push': '推送',
      'branch.merge': '将 {ref} 合并到 {current}',
      'branch.rebase': '将 {current} 变基到 {ref}',
      'branch.compare': '与 {ref} 比较',
      'branch.rename': '重命名…',
      'branch.delete': '删除',
      'branch.tracking': '跟踪的分支',
      'branch.trackingSet': '设为 {current} 的跟踪分支',
      'sync.update': '更新项目',
      'sync.fetch': '抓取（Fetch）',
      'sync.push': '推送（Push）',
      'sync.remotes': '管理远程…',
      'sync.stash': '暂存未提交改动',
      'sync.stashPop': '恢复最近一次暂存',
      'op.done': '{label}：已完成',
      'op.failed': '{label}失败：{message}',
      'op.stale': '当前运行的 Host 还没有这个操作，需要重启 DSH 让插件的 Host 端重新加载。',
      'verb.update': '更新项目',
      'verb.fetch': '抓取',
      'verb.push': '推送',
      'verb.checkout': '签出',
      'verb.merge': '合并',
      'verb.rebase': '变基',
      'verb.branch': '新建分支',
      'verb.rename': '重命名',
      'verb.delete': '删除分支',
      'verb.tracking': '设置跟踪分支',
      'verb.stash': '暂存',
      'verb.stashPop': '恢复暂存',
      'op.close': '关闭',
      'op.cancel': '取消',
      'op.confirm': '确定',
      'prompt.newBranch': '新建分支',
      'prompt.branchName': '分支名称',
      'prompt.branchFrom': '从 {ref} 创建',
      'prompt.rename': '重命名分支 {ref}',
      'prompt.checkoutRev': '签出标记或修订',
      'prompt.revName': '标记、分支或修订号',
      'prompt.tracking': '选择跟踪的远程分支',
      'prompt.none': '不跟踪',
      'confirm.deleteBody': '未合并的提交会被保留一段时间，但分支本身将消失。',
      'confirm.deleteUnmerged': '{ref} 还没有合并进当前分支，确认强制删除？',
      'state.merge': '合并尚未完成，存在需要解决的冲突。',
      'state.rebase': '变基尚未完成，存在需要解决的冲突。',
      'state.cherry-pick': '拣选尚未完成。',
      'state.revert': '还原尚未完成。',
      'state.bisect': '正在二分查找。',
      'state.continue': '继续',
      'state.abort': '中止',
      'compare.title': '{ref} 与 {base}',
      'compare.ahead': '{ref} 独有 {count} 个提交',
      'compare.behind': '{base} 独有 {count} 个提交',
      'compare.same': '两个分支指向同一个提交。',
      'compare.files': '文件差异',
      'compare.noFiles': '没有文件差异。',
      'compare.loading': '正在比较…',
      'remote.title': 'Git 远程',
      'remote.name': '名称',
      'remote.newName': '新远程名称',
      'remote.url': 'URL',
      'remote.add': '添加远程',
      'remote.remove': '删除该远程',
      'remote.none': '这个仓库还没有远程。',
      'remote.saving': '正在保存…',
      'remote.done': '远程已更新',
      'remote.incomplete': '请填写完整的远程名称和 URL。',
      'remote.renameTo': '重命名为',
    }

    const en = {
      'panel.title': 'Commit',
      'guide.sidebar': 'Review and commit the uncommitted changes of this project',
      'card.title': 'Git commit panel',
      'card.description': 'Review this project\'s uncommitted changes and commit them file by file.',
      'card.placement': 'Panel location',
      'card.placementHint': 'Takes effect immediately; no restart or reload needed.',
      'card.placement.tab': 'Tab above the conversation',
      'card.placement.sidebar': 'Right sidebar',
      'card.reset': 'Follow plugin config',
      'card.readOnly': 'This connection is read-only, so the plugin cannot be configured here.',
      'header.files': '{count} files',
      'header.refresh': 'Refresh changes',
      'toolbar.label': 'Actions',
      'toolbar.rollback': 'Rollback selected changes',
      'toolbar.showDiff': 'Show diff for the selected file',
      'toolbar.group': 'Group by directory',
      'toolbar.expandAll': 'Expand all',
      'toolbar.collapseAll': 'Collapse all',
      'toolbar.settings': 'Panel settings',
      'toolbar.close': 'Close and return to the conversation',
      'settings.title': 'Panel settings',
      'settings.autoRefresh': 'Auto refresh (4s)',
      'settings.selectByDefault': 'Select all files when a project opens',
      'settings.update': 'Update method',
      'settings.update.merge': 'Merge',
      'settings.update.rebase': 'Rebase',
      'settings.update.ffOnly': 'Fast-forward only',
      'header.project': 'Project',
      'header.branch': 'Branch',
      'header.changes': 'Changes',
      'header.searching': 'Searching for Git projects…',
      'header.noRepos': 'No Git repository in this workspace',
      'header.truncated': '(too many projects to list all)',
      'empty.noProject.title': 'No project yet',
      'empty.noProject.body': 'This Session has no working directory yet. Set one in the Session and its changes appear here automatically.',
      'empty.gitMissing.title': 'git is not available',
      'empty.gitMissing.body': 'Install git, or point gitBinary in the plugin\'s config row at the executable.',
      'empty.clean.title': 'No uncommitted changes',
      'empty.clean.body': 'The working tree is clean. New Agent edits appear here automatically.',
      'empty.noRepo.title': 'No uncommitted changes',
      'empty.noRepo.body': 'This project is not a Git repository yet. Initialize one to review and commit changes.',
      'empty.noRepo.init': 'Create Git repository',
      'empty.noRepo.initializing': 'Initializing…',
      'empty.noRepo.done': 'Repository created. Changes can be reviewed and committed now.',
      'empty.noRepo.doneFiles': 'Repository created with {files}; changes can be reviewed and committed now.',
      'error.load': 'Could not read changes: {message}',
      'empty.loadError.title': 'Could not read changes',
      'empty.retry': 'Retry',
      'error.commit': 'Commit failed: {message}',
      'error.rollback': 'Rollback failed: {message}',
      'rollback.title': 'Discard these changes?',
      'rollback.body': 'This drops the uncommitted changes of {count} file(s), including staged content, and deletes untracked files. This cannot be undone.',
      'rollback.confirm': 'Rollback',
      'rollback.cancel': 'Cancel',
      'notice.rolledBack': 'Rolled back {count} file(s)',
      'section.changes': 'Changes',
      'section.unversioned': 'Unversioned Files',
      'commit.push': 'Commit and Push',
      'pushing': 'Committing and pushing…',
      'notice.pushFailed': 'Committed {hash}, but the push failed: {message}',
      'notice.committedPushed': 'Committed {hash} · {subject} and pushed',
      'notice.noFiles': 'Select at least one file first.',
      'notice.needMessage': 'Write a commit message first.',
      'notice.committed': 'Committed {hash} · {subject}',
      'list.all': 'All',
      'list.selectAll': 'Select all changes',
      'list.unselectAll': 'Clear selection',
      'list.touched': 'Changed in this Session',
      'list.partial': 'partly staged',
      'list.partialHint': 'This file has both staged and unstaged changes; committing includes all unstaged content.',
      'commit.placeholder': 'Commit message (required)',
      'commit.submit': 'Commit selected',
      'commit.submitting': 'Committing…',
      'commit.hint': 'Only checked files are committed; unchecked changes stay in the working tree. ⌘/Ctrl + Enter commits.',
      'commit.count': '{count} of {total} selected',
      'preview.hint': 'Select a file on the left to see its change here.',
      'preview.old': 'Previous version',
      'preview.new': 'Current version',
      'preview.workingTree': 'Working tree',
      'preview.untrackedFile': 'Working tree · new file',
      'preview.noBase': 'No commit yet (empty)',
      'preview.deleted': 'File deleted',
      'edit.saving': 'Saving…',
      'edit.area': 'Edit the current version',
      'edit.saved': 'Saved to the working tree',
      'error.write': 'Could not save the file: {message}',
      'preview.resize': 'Drag to resize the two versions',
      'list.resize': 'Drag to resize the file list',
      'diff.binary': 'Binary file; no text diff to show.',
      'diff.tooLarge': 'File is too large to preview here.',
      'diff.truncated': 'Diff truncated',
      'status.modified': 'Modified',
      'status.added': 'Added',
      'status.deleted': 'Deleted',
      'status.renamed': 'Renamed',
      'status.untracked': 'Untracked',
      'status.conflict': 'Conflict',
      'branch.detached': 'detached HEAD',
      'branch.ahead': '{count} ahead',
      'branch.behind': '{count} behind',
      'toolbar.update': 'Update project (pull)',
      'toolbar.push': 'Push to the remote',
      'toolbar.remotes': 'Manage remotes',
      'branch.button': 'Branches and operations',
      'branch.menu': 'Branches and operations',
      'branch.search': 'Search branches and operations',
      'branch.loading': 'Reading branches…',
      'branch.empty': 'No branch matches',
      'branch.local': 'Local',
      'branch.remote': 'Remote',
      'branch.tags': 'Tags',
      'branch.current': 'current',
      'branch.gone': 'gone on the remote',
      'branch.new': 'New Branch…',
      'branch.newFrom': 'New Branch from {ref}…',
      'branch.checkoutRev': 'Checkout Tag or Revision…',
      'branch.checkout': 'Checkout',
      'branch.checkoutSmart': 'Smart Checkout (carry the uncommitted work)',
      'branch.update': 'Update',
      'branch.push': 'Push',
      'branch.merge': 'Merge {ref} into {current}',
      'branch.rebase': 'Rebase {current} onto {ref}',
      'branch.compare': 'Compare with {ref}',
      'branch.rename': 'Rename…',
      'branch.delete': 'Delete',
      'branch.tracking': 'Tracking Branch',
      'branch.trackingSet': 'Track as {current}',
      'sync.update': 'Update Project',
      'sync.fetch': 'Fetch',
      'sync.push': 'Push',
      'sync.remotes': 'Remotes…',
      'sync.stash': 'Stash the uncommitted changes',
      'sync.stashPop': 'Apply the newest stash',
      'op.done': '{label}: done',
      'op.failed': '{label} failed: {message}',
      'op.stale': 'The running Host does not have this operation yet; restart DSH so the plugin host reloads.',
      'verb.update': 'Update',
      'verb.fetch': 'Fetch',
      'verb.push': 'Push',
      'verb.checkout': 'Checkout',
      'verb.merge': 'Merge',
      'verb.rebase': 'Rebase',
      'verb.branch': 'New Branch',
      'verb.rename': 'Rename',
      'verb.delete': 'Delete Branch',
      'verb.tracking': 'Tracking Branch',
      'verb.stash': 'Stash',
      'verb.stashPop': 'Unstash',
      'op.close': 'Close',
      'op.cancel': 'Cancel',
      'op.confirm': 'OK',
      'prompt.newBranch': 'New Branch',
      'prompt.branchName': 'Branch name',
      'prompt.branchFrom': 'created from {ref}',
      'prompt.rename': 'Rename branch {ref}',
      'prompt.checkoutRev': 'Checkout Tag or Revision',
      'prompt.revName': 'Tag, branch or revision',
      'prompt.tracking': 'Pick the remote branch to track',
      'prompt.none': 'no tracking',
      'confirm.deleteBody': 'Unmerged commits stay recoverable for a while, but the branch itself is gone.',
      'confirm.deleteUnmerged': '{ref} is not merged into the current branch. Force the delete?',
      'state.merge': 'A merge is still open, with conflicts to resolve.',
      'state.rebase': 'A rebase is still open, with conflicts to resolve.',
      'state.cherry-pick': 'A cherry-pick is still open.',
      'state.revert': 'A revert is still open.',
      'state.bisect': 'A bisect is in progress.',
      'state.continue': 'Continue',
      'state.abort': 'Abort',
      'compare.title': '{ref} against {base}',
      'compare.ahead': '{ref} holds {count} commit(s) of its own',
      'compare.behind': '{base} holds {count} commit(s) of its own',
      'compare.same': 'Both branches point at the same commit.',
      'compare.files': 'File differences',
      'compare.noFiles': 'No file differences.',
      'compare.loading': 'Comparing…',
      'remote.title': 'Git Remotes',
      'remote.name': 'Name',
      'remote.newName': 'new remote name',
      'remote.url': 'URL',
      'remote.add': 'Add remote',
      'remote.remove': 'Remove this remote',
      'remote.none': 'This repository has no remote yet.',
      'remote.saving': 'Saving…',
      'remote.done': 'Remotes updated',
      'remote.incomplete': 'Give the remote both a name and a URL.',
      'remote.renameTo': 'rename to',
    }

    const PREFS_KEY = 'dsh-git-commit.prefs.v1'

    /**
     * The short verb each popup action reports under. The menu rows carry full
     * sentences ("Merge main into feature/mp"), which read badly in a notice.
     */
    const OP_VERB = {
      update: 'verb.update',
      fetch: 'verb.fetch',
      push: 'verb.push',
      checkout: 'verb.checkout',
      checkoutRev: 'verb.checkout',
      merge: 'verb.merge',
      rebase: 'verb.rebase',
      trackAs: 'verb.tracking',
      tracking: 'verb.tracking',
      rename: 'verb.rename',
      delete: 'verb.delete',
      newBranch: 'verb.branch',
      newFrom: 'verb.branch',
      stash: 'verb.stash',
      stashPop: 'verb.stashPop',
    }

    /**
     * Read the panel preferences.
     * @returns {{ autoRefresh: boolean, selectByDefault: boolean, updateStrategy: string }} current prefs.
     */
    function readPrefs() {
      const fallback = { autoRefresh: true, selectByDefault: true, updateStrategy: 'merge' }
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null || raw === '') return fallback
        const parsed = JSON.parse(raw)
        return {
          autoRefresh: typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : fallback.autoRefresh,
          selectByDefault: typeof parsed.selectByDefault === 'boolean' ? parsed.selectByDefault : fallback.selectByDefault,
          updateStrategy: ['merge', 'rebase', 'ff-only'].includes(parsed.updateStrategy)
            ? parsed.updateStrategy
            : fallback.updateStrategy,
        }
      } catch {
        return fallback
      }
    }

    /**
     * Persist the panel preferences.
     * @param {object} prefs - new value.
     */
    function writePrefs(prefs) {
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* storage can be unavailable */ }
    }

    /** Sidebar/tab glyph: one commit node between two history stems. */
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': 'true',
        style: { display: 'block' },
      },
        h('path', { d: 'M18 3v8.6', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
        h('path', { d: 'M18 24.4V33', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
        h('circle', { cx: 18, cy: 18, r: 6.6, stroke: 'currentColor', strokeWidth: 2.4 }),
        h('circle', { cx: 18, cy: 18, r: 2.3, fill: 'currentColor' }),
      )
    }

    /**
     * Last path segment of a directory.
     * @param {string} path - absolute path.
     * @returns {string} display name.
     */
    function baseName(path) {
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /**
     * Call one Host API method.
     * @param {string} method - status, diff, or commit.
     * @param {object} payload - JSON body.
     * @returns {Promise<object>} response data.
     */
    async function api(method, payload) {
      const response = await fetch(API_BASE + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const text = await response.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = null }
      if (!response.ok || body === null || body.ok !== true) {
        const message = body?.error?.message
        const error = new Error(typeof message === 'string' && message !== '' ? message : (text.slice(0, 300) || `HTTP ${response.status}`))
        // Keep the code: `not-found` means the running Host predates this panel.
        if (typeof body?.error?.code === 'string') error.code = body.error.code
        throw error
      }
      return body.data
    }

    /**
     * The text one thrown error becomes in the panel. A `not-found` from the
     * Host means the running Host is older than this panel, which only a
     * restart of DSH fixes, so it gets said plainly rather than as a bare
     * `unknown method "pull"`.
     * @param {function} t - translate.
     * @param {unknown} error - thrown value.
     * @returns {string} the message to show.
     */
    function errorText(t, error) {
      if (error instanceof Error && error.code === 'not-found') return t('op.stale')
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Read a project's saved commit-message draft.
     * @param {string} cwd - project directory.
     * @returns {string} saved text or an empty string.
     */
    function readDraft(cwd) {
      try {
        const value = window.localStorage.getItem('dsh-git-commit.draft.' + cwd)
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    }

    /**
     * Persist or clear one project's draft.
     * @param {string} cwd - project directory.
     * @param {string} text - current message.
     */
    function writeDraft(cwd, text) {
      try {
        const key = 'dsh-git-commit.draft.' + cwd
        if (text === '') window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, text)
      } catch {
        /* storage can be unavailable */
      }
    }

    /**
     * Translate one file status kind.
     * @param {string} kind - host kind.
     * @param {function} t - translate function.
     * @returns {string} localized label.
     */
    function statusLabel(kind, t) {
      if (kind === 'added') return t('status.added')
      if (kind === 'deleted') return t('status.deleted')
      if (kind === 'renamed') return t('status.renamed')
      if (kind === 'untracked') return t('status.untracked')
      if (kind === 'conflict') return t('status.conflict')
      return t('status.modified')
    }

    /**
     * Split files into the tracked-changes and unversioned sections.
     * @param {Array<object>} files - status entries.
     * @returns {{ changes: Array<object>, unversioned: Array<object> }} the two groups.
     */
    function splitFiles(files) {
      const changes = []
      const unversioned = []
      for (const file of files) {
        if (file.kind === 'untracked') unversioned.push(file)
        else changes.push(file)
      }
      return { changes, unversioned }
    }

    /**
     * Build a sorted directory tree over one section's files. A directory whose
     * only child is another directory collapses into one "src/client" row.
     * @param {Array<object>} files - section entries.
     * @param {Set<string>} collapsedDirs - collapsed directory keys.
     * @returns {Array<{ depth: number, kind: string, label: string, key: string, files?: Array<object>, file?: object }>} rows.
     */
    function buildTree(files, collapsedDirs) {
      const root = { dirs: new Map(), files: [] }
      for (const file of files) {
        const parts = file.path.split('/')
        let node = root
        const walked = []
        for (let index = 0; index < parts.length - 1; index += 1) {
          const name = parts[index]
          walked.push(name)
          const key = walked.join('/')
          if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [], key, label: name })
          node = node.dirs.get(name)
        }
        node.files.push({ ...file, name: parts[parts.length - 1] })
      }
      const collect = node => {
        const out = [...node.files]
        for (const child of node.dirs.values()) out.push(...collect(child))
        return out
      }
      const chainOf = node => {
        let current = node
        const names = [node.label]
        while (current.files.length === 0 && current.dirs.size === 1) {
          current = [...current.dirs.values()][0]
          names.push(current.label)
        }
        return { label: names.join('/'), end: current }
      }
      const rows = []
      const walk = (node, depth) => {
        const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
        for (const name of dirNames) {
          const child = node.dirs.get(name)
          const chain = chainOf(child)
          rows.push({ depth, kind: 'dir', label: chain.label, key: child.key, files: collect(chain.end) })
          if (!collapsedDirs.has(child.key)) walk(chain.end, depth + 1)
        }
        for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
          rows.push({ depth, kind: 'file', label: file.name, key: file.path, file })
        }
      }
      walk(root, 0)
      return rows
    }

    /**
     * Status glyph shown before a path.
     * @param {object} file - file entry.
     * @returns {string} one-letter code.
     */
    function statusCode(file) {
      if (file.kind === 'untracked') return 'U'
      if (file.kind === 'conflict') return '!'
      if (file.kind === 'added') return 'A'
      if (file.kind === 'deleted') return 'D'
      if (file.kind === 'renamed') return 'R'
      return 'M'
    }

    /**
     * Read the Workspace roster without breaking the hook rules: a component
     * hook when the slot kit supplies one, otherwise the cached roster the
     * injected service keeps current.
     * @param {object} props - view props.
     * @returns {Array<object>} Workspace rows with `path` and `sessionIds`.
     */
    function workspaceItemsOf(props) {
      if (typeof props.useWorkspaces === 'function') return props.useWorkspaces(state => state.items)
      return workspaceItemsCache()
    }

    /**
     * Subscribe to the module-level Workspace rows.
     * @returns {Array<object>} current rows.
     */
    function workspaceItemsCache() {
      const [rows, setRows] = useState(() => workspaceRowsRef.slice())
      useEffect(() => {
        const listener = () => setRows(workspaceRowsRef.slice())
        workspaceRowsListeners.add(listener)
        listener()
        return () => workspaceRowsListeners.delete(listener)
      }, [])
      return rows
    }

    /**
     * The global Changes panel.
     * @param {object} props - slot runtime props plus the injected translate seat.
     * @returns {React.ReactNode} panel.
     */
    function GitCommitPanel(props) {
      return h(ViewBoundary, null, h(GitCommitView, props))
    }

    /**
     * Small error boundary so a render failure shows a message instead of a
     * blank view slot (the host otherwise swaps in nothing).
     */
    class ViewBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('dsh-git-commit: view crashed', error)
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dshgc-root' },
            h('style', null, CSS),
            h('div', { className: 'dshgc-banner dshgc-banner-error' },
              'dsh-git-commit crash: ' + (this.state.error?.message ?? String(this.state.error))),
          )
        }
        return this.props.children
      }
    }

    /**
     * The Session this view belongs to. The view slot passes its scope target
     * as `owner`, whose `sessionId` is the bound Session; `props.sessionId`
     * exists on scopes that hand the standard kit to the component.
     * @param {object} props - view props.
     * @returns {string} Session id, or an empty string while unknown.
     */
    function resolveSessionId(props) {
      const candidates = [
        props.sessionId,
        props.handles?.sessionId,
        props.owner?.sessionId,
        props.owner?.id,
        props.inject?.sessionId,
        props.viewSessionId,
      ]
      for (const value of candidates) {
        if (typeof value === 'string' && value !== '') return value
      }
      const fallback = activeSessionId()
      return typeof fallback === 'string' ? fallback : ''
    }

    function GitCommitView(props) {
      const { t } = props
      const sessionId = resolveSessionId(props)
      const sessionCwd = sessionId === '' ? '' : cwdOfSession(sessionId)
      // Workspace membership straight from the Client Workspace registry. The
      // list snapshot carries `path`; it is the only authoritative mapping from
      // a Session to the folder the user opened as a workspace. The standard
      // hook is used when the slot kit provides it, else the service.
      const workspaceItems = workspaceItemsOf(props)
      const tabWorkspaceRoot = useMemo(() => {
        const items = Array.isArray(workspaceItems) ? workspaceItems : []
        for (const item of items) {
          const inList = Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)
          if (!inList) continue
          const path = typeof item.path === 'string' ? item.path : item.directory
          if (typeof path === 'string' && path !== '') return path
        }
        return undefined
      }, [workspaceItems, sessionId])
      const scanRoot = tabWorkspaceRoot ?? (sessionId === '' ? undefined : workspaceRootOfSession(sessionId))
      const [, bumpDiscovery] = useState(0)
      useEffect(() => subscribeViewWakeup(() => {
        // Wake-ups double as retries: a root whose first scan failed or came
        // back empty gets refreshed once the catalog is known to exist. The
        // tab's own workspace root is rescanned too, because membership can
        // disagree with the Session row while the registry catches up.
        for (const root of new Set([scanRoot, tabWorkspaceRoot, sessionCwd].filter(root => typeof root === 'string' && root !== ''))) {
          if (discoveryRecords.get(root)?.value !== undefined) continue
          void discoverWorkspace(root, false)
        }
        bumpDiscovery(tick => tick + 1)
      }), [scanRoot, tabWorkspaceRoot])
      const discoveryRecord = scanRoot === undefined ? undefined : discoverySource(scanRoot)
      const sessionRecord = sessionCwd === '' || sessionCwd === scanRoot ? undefined : discoverySource(sessionCwd)
      useEffect(() => {
        if (discoveryRecord === undefined) return undefined
        return discoveryRecord.subscribe(() => bumpDiscovery(tick => tick + 1))
      }, [discoveryRecord])
      useEffect(() => {
        if (sessionRecord === undefined) return undefined
        return sessionRecord.subscribe(() => bumpDiscovery(tick => tick + 1))
      }, [sessionRecord])
      const discovered = discoveryRecord?.getSnapshot()
      const sessionDiscovered = sessionRecord?.getSnapshot()
      const projectOptions = useMemo(() => {
        // The workspace folder and the Session's own folder are always
        // candidates; discovery adds every nested repository beneath them.
        const options = []
        const add = (path, name) => {
          const value = typeof path === 'string' ? path.replace(/\/+$/, '') : ''
          if (value === '' || options.some(option => option.path === value)) return
          options.push({ path: value, name: name ?? value.split('/').filter(Boolean).pop() ?? value })
        }
        add(tabWorkspaceRoot ?? workspaceRootOfSession(sessionId))
        add(sessionCwd)
        for (const repo of [...(sessionDiscovered?.repos ?? []), ...(discovered?.repos ?? [])]) add(repo.path, repo.name)
        return options
      }, [discovered, sessionDiscovered, sessionId, sessionCwd, tabWorkspaceRoot])
      const [cwd, setCwd] = useState('')
      const mountedSessionRef = useRef(sessionId)
      if (mountedSessionRef.current !== sessionId) {
        mountedSessionRef.current = sessionId
        manualPickRef.current = false
      }
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [selected, setSelected] = useState(() => new Set())
      const [selectedPath, setSelectedPath] = useState('')
      /** Working-tree pane autosave badge: idle | saving | saved. */
      const [saveState, setSaveState] = useState('idle')
      /** Width share of the left diff pane, 0.2 – 0.8. */
      const [splitRatio, setSplitRatio] = useState(0.5)
      /** Width of the file list in px, or null while the CSS default holds. */
      const [listWidth, setListWidth] = useState(null)
      /** The panel root, measured so the layout can react to its own seat. */
      const rootRef = useRef(null)
      /** The branch pill and its popup together, for the outside-click close. */
      const branchWrapRef = useRef(null)
      /** The branch list, the row the submenu belongs to, and the submenu itself. */
      const branchPopRef = useRef(null)
      const branchRowRef = useRef(null)
      const branchSubRef = useRef(null)
      /** True while the seat is too narrow for the side-by-side split. */
      const [narrow, setNarrow] = useState(false)
      const diffBoxRef = useRef(null)
      const splitRef = useRef(null)
      /** True while a divider is under the pointer, so the poll can wait out the drag. */
      const draggingRef = useRef(false)
      const leftPaneRef = useRef(null)
      const rightPaneRef = useRef(null)
      /** The always-editable working-tree body and its line-number gutter. */
      const editBodyRef = useRef(null)
      const editGutterRef = useRef(null)
      const editTimerRef = useRef(0)
      /** Last text written to disk, so a no-op save is skipped. */
      const lastSavedRef = useRef('')
      const previewRef = useRef(null)
      const flushSaveRef = useRef(null)
      const syncingScrollRef = useRef(false)
      const [preview, setPreview] = useState(null)
      previewRef.current = preview
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [draftCwd, setDraftCwd] = useState('')
      const [prefs, setPrefs] = useState(readPrefs)
      const [groupByDir, setGroupByDir] = useState(true)
      const [collapsedDirs, setCollapsedDirs] = useState(() => new Set())
      /** Group keys ('changes' | 'unversioned') the user folded away. */
      const [collapsedSections, setCollapsedSections] = useState(() => new Set())
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [rollbackTarget, setRollbackTarget] = useState(null)
      /** Whether the IDEA-style branch popup is open. */
      const [branchOpen, setBranchOpen] = useState(false)
      /** The host's `branches` answer, or null while it has never loaded. */
      const [branchData, setBranchData] = useState(null)
      const [branchLoading, setBranchLoading] = useState(false)
      const [branchQuery, setBranchQuery] = useState('')
      /** The one branch row whose action list is unfolded, `kind:name`. */
      const [branchExpanded, setBranchExpanded] = useState('')
      /** The open popup dialog: prompt, confirm, compare, or remotes. */
      const [dialog, setDialog] = useState(null)
      /** One sync/branch operation running; the panel is busy while it lasts. */
      const [opBusy, setOpBusy] = useState(false)
      const autoSelectRef = useRef(true)
      /** Set while the panel should preview the first changed file by itself. */
      const autoPreviewRef = useRef(true)
      /** Latest preview opener, for callers defined earlier in the component. */
      const openPreviewRef = useRef(null)
      const manualPickRef = useRef(false)
      const allCheckRef = useRef(null)
      const busyRef = useRef(false)
      const requestRef = useRef(0)
      const diffTokenRef = useRef(0)
      const textareaRef = useRef(null)

      // The right-sidebar seat is far narrower than the conversation band, so
      // the split follows the panel's own width, not the viewport's.
      useEffect(() => {
        const el = rootRef.current
        if (el === null || typeof ResizeObserver !== 'function') return undefined
        const measure = () => setNarrow(el.clientWidth < NARROW_PX)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

      const switchProject = useCallback((next) => {
        if (next === '' || next === cwd) return
        // Text typed into the previous project's pane belongs on disk first.
        window.clearTimeout(editTimerRef.current)
        void flushSaveRef.current?.()
        // Drop every value derived from the previous directory before its
        // status can be mistaken for this one.
        requestRef.current += 1
        diffTokenRef.current += 1
        autoSelectRef.current = readPrefs().selectByDefault
        autoPreviewRef.current = true
        setLoading(true)
        setData(null)
        setLoadError('')
        setSelected(new Set())
        setSelectedPath('')
        setPreview(null)
        setNotice(null)
        setCwd(next)
      }, [cwd])

      // The bound Session's own repository wins; otherwise the first project
      // found under its workspace. A manual pick inside this tab holds until
      // the Session changes.
      useEffect(() => {
        const options = projectOptions
        if (options.length === 0) return
        // A Session opened at the workspace root picks the first discovered
        // repository; one opened inside a sub-project picks that sub-project.
        const discoveredPaths = new Set([
          ...(sessionDiscovered?.repos ?? []).map(repo => repo.path),
          ...(discovered?.repos ?? []).map(repo => repo.path),
        ])
        const preferred = discoveredPaths.has(sessionCwd)
          ? sessionCwd
          : (sessionDiscovered?.repos?.[0]?.path ?? discovered?.repos?.[0]?.path ?? options[0].path)
        if (manualPickRef.current === true) {
          // A manual pick that is no longer valid falls back to the preferred
          // project so the body is never empty.
          if (!options.some(option => option.path === cwd)) switchProject(preferred)
          return
        }
        if (preferred === cwd) return
        switchProject(preferred)
      }, [projectOptions, discovered, sessionDiscovered, sessionCwd, cwd, switchProject])

      // The draft belongs to the project, not to the mounted panel.
      useEffect(() => {
        setMessage(cwd === '' ? '' : readDraft(cwd))
        setDraftCwd(cwd)
      }, [cwd])

      useEffect(() => {
        if (cwd === '' || draftCwd !== cwd) return
        writeDraft(cwd, message)
      }, [cwd, message, draftCwd])

      const refresh = useCallback(async (options = {}) => {
        if (cwd === '') { setData(null); setLoading(false); setLoadError(''); return }
        const generation = requestRef.current + 1
        requestRef.current = generation
        if (options.silent !== true) setLoading(true)
        try {
          const next = await api('status', { cwd, sessionId })
          if (requestRef.current !== generation) return
          setData({ ...next, cwd })
          setLoadError('')
          const files = Array.isArray(next.files) ? next.files : []
          // The IDE opens the first change by itself; so does this panel.
          if (autoPreviewRef.current && files.length > 0) {
            autoPreviewRef.current = false
            void openPreviewRef.current?.(files[0])
          }
          if (autoSelectRef.current) {
            // Select every file once when the project opens, then stop:
            // files that appear later must not be committed unseen.
            autoSelectRef.current = false
            setSelected(new Set(files.map(file => file.path)))
          } else {
            setSelected(previous => {
              const keep = new Set()
              for (const file of files) if (previous.has(file.path)) keep.add(file.path)
              return keep
            })
          }
        } catch (error) {
          if (requestRef.current !== generation) return
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          if (requestRef.current === generation && options.silent !== true) setLoading(false)
        }
      }, [cwd])

      useEffect(() => { void refresh() }, [refresh])

      useEffect(() => {
        if (cwd === '' || prefs.autoRefresh !== true) return undefined
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'visible' || busyRef.current) return
          // A refresh mid-drag would rebuild the whole list under the pointer.
          if (draggingRef.current) return
          if (requestRef.current === 0) return
          void refresh({ silent: true })
        }, POLL_MS)
        const onFocus = () => { if (!busyRef.current && !draggingRef.current) void refresh({ silent: true }) }
        window.addEventListener('focus', onFocus)
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [cwd, refresh, prefs.autoRefresh])

      const view = data !== null && data.cwd === cwd ? data : null
      const files = Array.isArray(view?.files) ? view.files : []
      const selectedFiles = files.filter(file => selected.has(file.path))
      const allSelected = files.length > 0 && selectedFiles.length === files.length
      const partiallySelected = selectedFiles.length > 0 && !allSelected
      const canCommit = !busy && !opBusy && !loading && view !== null && selectedFiles.length > 0 && message.trim() !== ''

      useEffect(() => {
        if (allCheckRef.current !== null) {
          allCheckRef.current.indeterminate = partiallySelected
        }
      }, [partiallySelected])

      /**
       * Current working-tree text as typed in the editable body. Placeholder
       * islands (deleted lines, hunk headers) are not file lines and are
       * skipped; a block holding soft newlines counts as that many lines.
       * @returns {string | null} the file text, or null with no body mounted.
       */
      const bodyText = () => {
        const body = editBodyRef.current
        if (body === null) return null
        const parts = []
        for (const child of body.children) {
          if (child.getAttribute('contenteditable') === 'false') continue
          parts.push(...child.textContent.split('\n'))
        }
        return parts.join('\n')
      }

      /** Repaint the gutter numbers from the body's current blocks. */
      const syncGutter = useCallback(() => {
        const body = editBodyRef.current
        const gutter = editGutterRef.current
        if (body === null || gutter === null) return
        const cells = []
        let number = 0
        for (const child of body.children) {
          if (child.getAttribute('contenteditable') === 'false') {
            cells.push('')
            continue
          }
          const pieces = child.textContent.split('\n').length
          for (let k = 0; k < pieces; k += 1) {
            number += 1
            cells.push(String(number))
          }
        }
        gutter.innerHTML = cells.map(cell => `<div class="dshgc-gutter-cell">${cell}</div>`).join('')
      }, [])

      /**
       * Write the typed pane text back to the working tree when it changed.
       * @returns {Promise<void>} settles after the write attempt.
       */
      const flushSave = useCallback(async () => {
        const shown = previewRef.current
        if (shown === null || shown.loading === true || shown.error !== undefined) return
        if (shown.truncated === true || shown.kind === 'binary' || shown.kind === 'tooLarge') return
        if (!hasWorkingTreeContent(Array.isArray(shown.rows) ? shown.rows : [])) return
        const content = bodyText()
        if (content === null || content === lastSavedRef.current) return
        setSaveState('saving')
        try {
          await api('write', { cwd, path: shown.path, content })
          lastSavedRef.current = content
          setSaveState('saved')
          window.setTimeout(() => setSaveState(previous => (previous === 'saved' ? 'idle' : previous)), 1600)
        } catch (error) {
          setSaveState('idle')
          setNotice({ kind: 'error', text: t('error.write', { message: error instanceof Error ? error.message : String(error) }) })
        }
      }, [cwd, t])
      flushSaveRef.current = flushSave

      /** Typing renumbers the gutter at once and schedules the debounced write. */
      const onEditInput = useCallback(() => {
        syncGutter()
        window.clearTimeout(editTimerRef.current)
        editTimerRef.current = window.setTimeout(() => { void flushSave() }, 800)
      }, [flushSave, syncGutter])

      /**
       * Show one file's change on the right: a two-column diff for a tracked
       * file, or the whole content for an untracked one. The working-tree side
       * arrives ready to type in; its text is read back for the autosave, so
       * the file content is fetched alongside the diff.
       * @param {object} file - status entry.
       */
      const openPreview = useCallback(async (file) => {
        const token = diffTokenRef.current + 1
        diffTokenRef.current = token
        // Anything typed into the previous file's pane belongs on disk first.
        await flushSave()
        if (diffTokenRef.current !== token) return
        setSelectedPath(file.path)
        setPreview({ loading: true, path: file.path })
        window.clearTimeout(editTimerRef.current)
        setSaveState('idle')
        try {
          const [result, read] = await Promise.all([
            api('preview', { cwd, path: file.path, origPath: file.origPath }),
            api('read', { cwd, path: file.path }).catch(() => null),
          ])
          if (diffTokenRef.current !== token) return
          const rows = Array.isArray(result.rows) ? result.rows : []
          let lastNo = 0
          for (const row of rows) {
            if (typeof row.newNo === 'number' && row.newNo > lastNo) lastNo = row.newNo
          }
          const content = read !== null && typeof read.content === 'string' ? read.content : null
          lastSavedRef.current = content ?? ''
          // git drops trailing blank context lines; the file still has them.
          const extra = content === null ? 0 : Math.max(0, content.split('\n').length - lastNo)
          setPreview({ ...result, loading: false, extraLines: extra })
        } catch (error) {
          if (diffTokenRef.current !== token) return
          setPreview({ path: file.path, error: error instanceof Error ? error.message : String(error), rows: [] })
        }
      }, [cwd, flushSave])
      openPreviewRef.current = openPreview

      /**
       * One horizontal drag. The pointer paints straight onto the element once per
       * frame and only the final position reaches React: a list holding thousands
       * of rows cannot afford a re-render per mousemove, which is what made the
       * divider stutter. The page locks its cursor and stops selecting text until
       * the pointer is up.
       * @param {number} startX - where the press landed, so a click keeps the width.
       * @param {(clientX: number) => void} onMove - paint one pointer position.
       * @param {(clientX: number) => void} onStop - commit where the drag ended.
       */
      const dragHorizontally = useCallback((startX, onMove, onStop) => {
        let lastX = startX
        let pending = 0
        const paint = () => { pending = 0; onMove(lastX) }
        /** @param {MouseEvent} moveEvent - the pointer moving. */
        const move = (moveEvent) => {
          lastX = moveEvent.clientX
          // Several events can land in one frame; the screen only repaints once.
          if (pending === 0) pending = window.requestAnimationFrame(paint)
        }
        const stop = () => {
          if (pending !== 0) { window.cancelAnimationFrame(pending); onMove(lastX) }
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', stop)
          draggingRef.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          onStop(lastX)
        }
        draggingRef.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', stop)
      }, [])

      /**
       * Drag the divider between the two versions. The panes always fill the
       * pane width, so only their ratio changes — never a page-level scroll.
       * @param {React.MouseEvent} event - mousedown on the splitter.
       */
      const startSplitDrag = useCallback((event) => {
        const box = diffBoxRef.current
        if (box === null) return
        event.preventDefault()
        const rect = box.getBoundingClientRect()
        const share = clientX => Math.min(0.8, Math.max(0.2, (clientX - rect.left) / rect.width))
        dragHorizontally(
          event.clientX,
          clientX => { box.style.setProperty('--dshgc-left-share', `${(share(clientX) * 100).toFixed(2)}%`) },
          clientX => { setSplitRatio(share(clientX)) },
        )
      }, [dragHorizontally])

      /**
       * Drag the divider between the file list and the diff. The list follows the
       * pointer in pixels; the diff keeps whatever width is left over.
       * @param {React.MouseEvent} event - mousedown on the splitter.
       */
      const startListDrag = useCallback((event) => {
        const box = splitRef.current
        if (box === null) return
        event.preventDefault()
        const rect = box.getBoundingClientRect()
        // The diff still has to be readable, so the list cannot eat the panel.
        const widest = Math.max(200, rect.width - 300)
        const widthAt = clientX => Math.min(widest, Math.max(200, clientX - rect.left))
        dragHorizontally(
          event.clientX,
          clientX => { box.style.setProperty('--dshgc-list-width', `${widthAt(clientX)}px`) },
          clientX => { setListWidth(widthAt(clientX)) },
        )
      }, [dragHorizontally])

      /**
       * Mirror vertical scrolling between the two versions so the rows stay
       * side by side; horizontal scrolling stays independent.
       * @param {string} side - which pane moved.
       * @param {React.UIEvent} event - scroll event.
       */
      const syncPaneScroll = useCallback((side, event) => {
        if (syncingScrollRef.current) return
        const source = event.currentTarget
        const other = side === 'left' ? rightPaneRef.current : leftPaneRef.current
        if (other === null) return
        syncingScrollRef.current = true
        other.scrollTop = source.scrollTop
        window.requestAnimationFrame(() => { syncingScrollRef.current = false })
      }, [])

      // A file opens on its first change: both versions are scrolled by the
      // same amount, so the columns start on the same line.
      useEffect(() => {
        if (preview === null || preview.loading === true || preview.error !== undefined) return
        const rows = Array.isArray(preview.rows) ? preview.rows : []
        const firstChange = rows.findIndex(row => row.type === 'add' || row.type === 'del' || row.type === 'mod')
        const target = firstChange > 0 ? firstChange : 0
        window.requestAnimationFrame(() => {
          for (const pane of [leftPaneRef.current, rightPaneRef.current]) {
            if (pane === null || pane === undefined) continue
            pane.scrollTop = Math.max(0, target * 18 - pane.clientHeight / 2 + 18)
          }
        })
      }, [preview])

      // The gutter numbers come from the body's blocks, so every freshly
      // painted preview needs one gutter pass once its DOM exists.
      useEffect(() => {
        const id = window.requestAnimationFrame(() => { syncGutter() })
        return () => { window.cancelAnimationFrame(id) }
      }, [preview, cwd, syncGutter])

      // Leaving the tab must not lose typed text: flush on the way out.
      useEffect(() => () => {
        window.clearTimeout(editTimerRef.current)
        void flushSaveRef.current?.()
      }, [])

      const toggleSelected = useCallback((path) => {
        autoSelectRef.current = false
        setSelected(previous => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      }, [])

      /**
       * Check or clear every file of one section.
       * @param {Array<object>} entries - section files.
       * @param {boolean} selectAll - whether to select or clear them.
       */
      /**
       * Fold or unfold one group, the way a tree node collapses.
       * @param {string} key - group key.
       */
      const toggleSectionCollapse = useCallback((key) => {
        setCollapsedSections(previous => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      const toggleSection = useCallback((entries, selectAll) => {
        autoSelectRef.current = false
        setSelected(previous => {
          const next = new Set(previous)
          for (const file of entries) {
            if (selectAll) next.add(file.path)
            else next.delete(file.path)
          }
          return next
        })
      }, [])

      const toggleAll = useCallback(() => {
        const nextAll = !allSelected
        autoSelectRef.current = false
        setSelected(nextAll ? new Set(files.map(file => file.path)) : new Set())
      }, [allSelected, files])

      const chooseProject = useCallback((event) => {
        const next = event.target.value
        if (next === '' || next === cwd) return
        manualPickRef.current = true
        switchProject(next)
      }, [cwd, switchProject])

      const submit = useCallback(async (withPush) => {
        if (busy || view === null) return
        if (selectedFiles.length === 0) {
          setNotice({ kind: 'error', text: t('notice.noFiles') })
          return
        }
        const trimmed = message.trim()
        if (trimmed === '') {
          setNotice({ kind: 'error', text: t('notice.needMessage') })
          textareaRef.current?.focus()
          return
        }
        // Text typed into the pane but not yet autosaved must be on disk
        // before the commit reads the working tree.
        await flushSave()
        busyRef.current = true
        requestRef.current += 1
        setBusy(true)
        setNotice(null)
        try {
          const result = await api('commit', {
            cwd,
            sessionId,
            message: trimmed,
            paths: selectedFiles.map(file => file.path),
            push: withPush === true,
          })
          setMessage('')
          writeDraft(cwd, '')
          setSelectedPath('')
          setPreview(null)
          setNotice(result.push === null || result.push === undefined
            ? { kind: 'ok', text: t('notice.committed', { hash: result.commit.hash, subject: result.commit.subject }) }
            : result.push.ok === true
              ? { kind: 'ok', text: t('notice.committedPushed', { hash: result.commit.hash, subject: result.commit.subject }) }
              : { kind: 'error', text: t('notice.pushFailed', { hash: result.commit.hash, message: result.push.error }) })
          autoSelectRef.current = false
          setSelected(new Set())
          if (result.status !== null && result.status !== undefined) {
            setData({ ...result.status, cwd })
          } else {
            await refresh({ silent: true })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: t('error.commit', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }, [busy, cwd, flushSave, message, refresh, selectedFiles, t, view])

      const initRepository = useCallback(async () => {
        if (busy || cwd === '') return
        busyRef.current = true
        requestRef.current += 1
        setBusy(true)
        setNotice(null)
        try {
          const next = await api('init', { cwd, sessionId })
          setData({ ...next, cwd })
          setLoadError('')
          setSelected(new Set())
          const created = Array.isArray(next.created) ? next.created : []
          setNotice({
            kind: 'ok',
            text: created.length > 0 ? t('empty.noRepo.doneFiles', { files: created.join(', ') }) : t('empty.noRepo.done'),
          })
          // The scan answer for this workspace is stale now.
          for (const root of new Set([scanRoot, sessionCwd].filter(root => typeof root === 'string' && root !== ''))) {
            void discoverWorkspace(root, true)
          }
        } catch (error) {
          setNotice({ kind: 'error', text: t('error.commit', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }, [busy, cwd, scanRoot, sessionCwd, sessionId, t])

      const runRollback = useCallback(async () => {
        const paths = Array.isArray(rollbackTarget?.paths) ? rollbackTarget.paths : []
        setRollbackTarget(null)
        if (paths.length === 0 || busy) return
        busyRef.current = true
        requestRef.current += 1
        setBusy(true)
        setNotice(null)
        try {
          const result = await api('rollback', { cwd, sessionId, paths })
          setSelected(previous => {
            const next = new Set(previous)
            for (const path of paths) next.delete(path)
            return next
          })
          setSelectedPath('')
          setPreview(null)
          if (result.status !== null && result.status !== undefined) setData({ ...result.status, cwd })
          setNotice({ kind: 'ok', text: t('notice.rolledBack', { count: result.rolledBack.length }) })
        } catch (error) {
          setNotice({ kind: 'error', text: t('error.rollback', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      }, [busy, cwd, rollbackTarget, t])

      /**
       * Read the branch table the popup shows.
       * @returns {Promise<void>} settles when the answer is in state.
       */
      const loadBranches = useCallback(async () => {
        if (cwd === '') return
        setBranchLoading(true)
        try {
          setBranchData(await api('branches', { cwd }))
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(t, error) })
        } finally {
          setBranchLoading(false)
        }
      }, [cwd, t])

      const openBranchPopup = useCallback(() => {
        const next = !branchOpen
        setBranchOpen(next)
        setBranchExpanded('')
        if (next) {
          setBranchQuery('')
          void loadBranches()
        }
      }, [branchOpen, loadBranches])

      // Clicking anywhere else closes the popup, the way an IDE menu does.
      useEffect(() => {
        if (!branchOpen) return undefined
        /**
         * @param {PointerEvent} event - the press.
         */
        const onPointerDown = (event) => {
          const box = branchWrapRef.current
          if (box !== null && box.contains(event.target)) return
          setBranchOpen(false)
          setBranchExpanded('')
        }
        window.addEventListener('pointerdown', onPointerDown, true)
        return () => { window.removeEventListener('pointerdown', onPointerDown, true) }
      }, [branchOpen])

      // The branch table belongs to one project, so a switch drops the old answer.
      useEffect(() => {
        setBranchData(null)
        setBranchOpen(false)
        setBranchExpanded('')
        setDialog(null)
      }, [cwd])

      // The popup hangs under the pill, yet never past the panel's own edge.
      useEffect(() => {
        const box = branchWrapRef.current
        const root = rootRef.current
        if (!branchOpen || box === null || root === null) return
        const width = Math.min(460, root.clientWidth - 28)
        const left = box.getBoundingClientRect().left - root.getBoundingClientRect().left
        const clamped = Math.max(14, Math.min(left, root.clientWidth - width - 14))
        box.style.setProperty('--dshgc-pop-left', `${Math.round(clamped)}px`)
        box.style.setProperty('--dshgc-pop-width', `${Math.round(width)}px`)
      }, [branchOpen, narrow])

      // The second-level menu hangs beside the row it came from, IDEA's shape.
      // It lives outside the list so the list's own scroll cannot clip it.
      const positionSubmenu = useCallback(() => {
        const wrap = branchWrapRef.current
        const root = rootRef.current
        const pop = branchPopRef.current
        const row = branchRowRef.current
        const sub = branchSubRef.current
        if (wrap === null || root === null || pop === null || row === null || sub === null) return
        const place = submenuPlacement(
          root.getBoundingClientRect(),
          pop.getBoundingClientRect(),
          row.getBoundingClientRect(),
          { width: sub.offsetWidth, height: sub.offsetHeight },
        )
        wrap.style.setProperty('--dshgc-sub-left', `${place.left}px`)
        wrap.style.setProperty('--dshgc-sub-top', `${place.top}px`)
      }, [])

      useLayoutEffect(() => {
        if (branchOpen && branchExpanded !== '') positionSubmenu()
      }, [positionSubmenu, branchOpen, branchExpanded, branchData, branchQuery, narrow])

      // Scrolling the list moves the row, so the menu has to follow it.
      useEffect(() => {
        const pop = branchPopRef.current
        if (!branchOpen || branchExpanded === '' || pop === null) return undefined
        const onScroll = () => { positionSubmenu() }
        pop.addEventListener('scroll', onScroll)
        return () => { pop.removeEventListener('scroll', onScroll) }
      }, [positionSubmenu, branchOpen, branchExpanded])

      /**
       * Run one branch or sync operation and fold the answer back into the panel.
       *
       * A merge or rebase can stop half-done with conflicts, so even a failure
       * re-reads the status: the banner has to say what is still open.
       * @param {string} method - the host route.
       * @param {object} payload - the body beyond cwd and session.
       * @param {string} label - what to call the operation in the notice.
       * @param {boolean} [close] - whether to hide the popup afterwards.
       * @returns {Promise<object | null>} the payload, or null when it failed.
       */
      const runOp = useCallback(async (method, payload, label, close) => {
        if (opBusy || cwd === '') return null
        setOpBusy(true)
        setNotice(null)
        try {
          const result = await api(method, { cwd, sessionId, ...payload })
          if (result.status !== null && result.status !== undefined) setData({ ...result.status, cwd })
          setBranchData(null)
          if (close === true) {
            setBranchOpen(false)
            setBranchExpanded('')
          }
          setNotice({ kind: 'ok', text: t('op.done', { label }) })
          return result
        } catch (error) {
          const detail = errorText(t, error)
          setNotice({ kind: 'error', text: t('op.failed', { label, message: detail }) })
          setBranchData(null)
          await refresh({ silent: true })
          return null
        } finally {
          setOpBusy(false)
        }
      }, [cwd, opBusy, refresh, sessionId, t])

      /**
       * Open the compare dialog and fill it in.
       * @param {object} branch - the branch row that asked.
       * @returns {Promise<void>} settles when the table is in state.
       */
      const openCompare = useCallback(async (branch) => {
        const base = branchData?.current ?? ''
        setDialog({
          kind: 'compare',
          title: t('compare.title', { ref: branch.name, base: base === '' ? 'HEAD' : base }),
          loading: true,
          error: '',
          data: null,
        })
        try {
          const data = await api('compare', { cwd, ref: branch.name })
          setDialog(previous => (previous === null || previous.kind !== 'compare' ? previous : { ...previous, loading: false, data }))
        } catch (error) {
          setDialog(previous => (previous === null || previous.kind !== 'compare'
            ? previous
            : { ...previous, loading: false, error: errorText(t, error) }))
        }
      }, [branchData, cwd, t])

      /**
       * Open the remote manager with the table read from the host.
       * @returns {Promise<void>} settles when the rows are in state.
       */
      const openRemotes = useCallback(async () => {
        setDialog({ kind: 'remotes', title: t('remote.title'), loading: true, error: '', rows: [], original: [] })
        try {
          const answer = await api('remotes', { cwd })
          const original = Array.isArray(answer.remotes) ? answer.remotes : []
          setDialog(previous => (previous === null || previous.kind !== 'remotes'
            ? previous
            : {
              ...previous,
              loading: false,
              original,
              rows: original.map(row => ({ name: row.name, url: row.url, originName: row.name })),
            }))
        } catch (error) {
          setDialog(previous => (previous === null || previous.kind !== 'remotes'
            ? previous
            : { ...previous, loading: false, error: errorText(t, error) }))
        }
      }, [cwd, t])

      /**
       * Apply the edited remote table as one ordered batch of git calls.
       * @param {Array<object>} rows - the draft table.
       * @param {Array<object>} original - the table as it was loaded.
       * @returns {Promise<void>} settles when every operation has run.
       */
      const saveRemotes = useCallback(async (rows, original) => {
        const ops = diffRemotes(original, rows)
        if (ops.length === 0) {
          setDialog(null)
          return
        }
        setOpBusy(true)
        setNotice(null)
        try {
          let last = null
          for (const op of ops) last = await api('remote', { cwd, sessionId, ...op })
          if (last !== null && last.status !== null && last.status !== undefined) setData({ ...last.status, cwd })
          setDialog(null)
          setBranchData(null)
          setNotice({ kind: 'ok', text: t('remote.done') })
        } catch (error) {
          setNotice({ kind: 'error', text: t('op.failed', { label: t('remote.title'), message: errorText(t, error) }) })
          setDialog(null)
          setBranchData(null)
          await refresh({ silent: true })
        } finally {
          setOpBusy(false)
        }
      }, [cwd, opBusy, refresh, sessionId, t])

      /**
       * Delete a branch, and ask again with force when git says it is unmerged.
       * @param {object} branch - the branch row.
       * @param {boolean} force - whether to override the unmerged check.
       * @returns {Promise<void>} settles when the delete has run.
       */
      const deleteBranch = useCallback(async (branch, force) => {
        const done = await runOp('branch', { action: 'delete', name: branch.name, force }, t('branch.delete'), true)
        if (done === null && force !== true) {
          setDialog({
            kind: 'confirm',
            title: t('confirm.deleteUnmerged', { ref: branch.name }),
            body: t('confirm.deleteBody'),
            confirm: t('branch.delete'),
            danger: true,
            run: () => { void deleteBranch(branch, true) },
          })
        }
      }, [runOp, t])

      /**
       * Do what one popup row asked for.
       * @param {object} action - `{ id, label, command }` from the popup.
       * @param {object | null} branch - the branch row it belongs to, if any.
       */
      const runAction = useCallback((action, branch) => {
        const label = t(OP_VERB[action.id] ?? 'branch.menu')
        const name = branch === null || branch === undefined ? '' : branch.name
        switch (action.id) {
          case 'update':
            void runOp('pull', { strategy: prefs.updateStrategy }, label, true)
            break
          case 'fetch':
            void runOp('fetch', {}, label, true)
            break
          case 'push':
            void runOp('push', {}, label, true)
            break
          case 'stash':
            void runOp('stash', { action: 'push' }, label, true)
            break
          case 'stashPop':
            void runOp('stash', { action: 'pop' }, label, true)
            break
          case 'checkout':
            void runOp('checkout', { rev: name, smart: true }, label, true)
            break
          case 'merge':
            void runOp('merge', { ref: name }, label, true)
            break
          case 'rebase':
            void runOp('rebase', { onto: name }, label, true)
            break
          case 'trackAs':
            void runOp('tracking', { upstream: name }, label, true)
            break
          case 'compare':
            void openCompare(branch)
            break
          case 'remotes':
            void openRemotes()
            break
          case 'delete':
            void deleteBranch(branch, false)
            break
          case 'newBranch':
            setDialog({
              kind: 'prompt',
              title: t('prompt.newBranch'),
              verb: label,
              label: t('prompt.branchName'),
              placeholder: t('prompt.branchName'),
              hint: branchData?.current ? t('prompt.branchFrom', { ref: branchData.current }) : '',
              value: '',
              method: 'branch',
              field: 'name',
              extra: { action: 'create', checkout: true },
            })
            break
          case 'newFrom':
            setDialog({
              kind: 'prompt',
              title: t('prompt.newBranch'),
              verb: label,
              label: t('prompt.branchName'),
              placeholder: t('prompt.branchName'),
              hint: t('prompt.branchFrom', { ref: name }),
              value: '',
              method: 'branch',
              field: 'name',
              extra: { action: 'create', checkout: true, start: name },
            })
            break
          case 'checkoutRev':
            setDialog({
              kind: 'prompt',
              title: t('prompt.checkoutRev'),
              verb: label,
              label: t('prompt.revName'),
              placeholder: 'v1.2.0',
              value: '',
              method: 'checkout',
              field: 'rev',
              extra: { smart: true },
            })
            break
          case 'rename':
            setDialog({
              kind: 'prompt',
              title: t('prompt.rename', { ref: name }),
              verb: label,
              label: t('remote.renameTo'),
              value: name,
              method: 'branch',
              field: 'newName',
              extra: { action: 'rename', name },
            })
            break
          case 'tracking':
            setDialog({
              kind: 'prompt',
              title: t('branch.tracking'),
              verb: label,
              label: t('prompt.tracking'),
              value: branchData?.upstream ?? '',
              select: (branchData?.remote ?? []).map(row => row.name),
              method: 'tracking',
              field: 'upstream',
              extra: {},
            })
            break
          default:
            break
        }
      }, [branchData, deleteBranch, openCompare, openRemotes, prefs, runOp, t])

      /**
       * Edit one field of the open dialog.
       * @param {string} field - the field name.
       * @param {string} value - its new text.
       */
      const editDialog = useCallback((field, value) => {
        setDialog(previous => (previous === null ? previous : { ...previous, [field]: value }))
      }, [])

      /**
       * Edit one row of the remote table.
       * @param {number} index - the row, or -1 for the append and remove actions.
       * @param {string} field - 'name', 'url', 'add' or 'remove'.
       * @param {string} value - the new text.
       */
      const editRemoteRow = useCallback((index, field, value) => {
        setDialog(previous => {
          if (previous === null || previous.kind !== 'remotes') return previous
          const rows = (previous.rows ?? []).map(row => ({ ...row }))
          if (field === 'add') return { ...previous, rows: [...rows, { name: '', url: '', originName: '' }] }
          if (field === 'remove') return { ...previous, rows: rows.filter((_, at) => at !== index) }
          if (rows[index] === undefined) return previous
          rows[index] = { ...rows[index], [field]: value }
          return { ...previous, rows, error: '' }
        })
      }, [])

      /** Run the open dialog's action. */
      const submitDialog = useCallback(() => {
        if (dialog === null || dialog === undefined) return
        if (dialog.kind === 'remotes') {
          const rows = (dialog.rows ?? []).map(row => ({ ...row, name: String(row.name).trim(), url: String(row.url).trim() }))
          if (rows.some(row => row.name === '' || row.url === '')) {
            setDialog(previous => (previous === null || previous.kind !== 'remotes'
              ? previous
              : { ...previous, error: t('remote.incomplete') }))
            return
          }
          void saveRemotes(rows, dialog.original ?? [])
          return
        }
        if (typeof dialog.run === 'function') {
          const run = dialog.run
          setDialog(null)
          run()
          return
        }
        if (dialog.method === undefined) {
          setDialog(null)
          return
        }
        const value = String(dialog.value ?? '').trim()
        if (dialog.select === undefined && value === '') return
        const payload = { ...dialog.extra }
        payload[dialog.field] = value
        setDialog(null)
        void runOp(dialog.method, payload, dialog.verb ?? dialog.title, true)
      }, [dialog, runOp, saveRemotes, t])

      const toggleDir = useCallback((key) => {
        setCollapsedDirs(previous => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      const expandAllDirs = useCallback(() => setCollapsedDirs(new Set()), [])
      const collapseAllDirs = useCallback(() => {
        const all = new Set()
        for (const file of files) {
          const parts = file.path.split('/')
          for (let index = 1; index < parts.length; index += 1) all.add(parts.slice(0, index).join('/'))
        }
        setCollapsedDirs(all)
      }, [files])

      const updatePref = useCallback((field, value) => {
        setPrefs(previous => {
          const next = { ...previous, [field]: value }
          writePrefs(next)
          return next
        })
      }, [])

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Escape') {
          if (dialog !== null && dialog !== undefined) {
            setDialog(null)
            return
          }
          if (branchOpen) {
            setBranchOpen(false)
            setBranchExpanded('')
          }
          return
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          if (dialog !== null && dialog !== undefined && dialog.kind !== 'remotes') {
            submitDialog()
            return
          }
          void submit(false)
        }
      }, [branchOpen, dialog, submit, submitDialog])



      const branch = view?.repo?.branch
      const branchText = branch !== null && branch !== undefined && branch !== ''
        ? branch
        : (view?.repo !== null && view?.repo !== undefined ? t('branch.detached') : '')

      return h('div', { className: narrow ? 'dshgc-root dshgc-narrow' : 'dshgc-root', ref: rootRef, onKeyDown },
        h('style', null, CSS),
        h('div', { className: 'dshgc-top' },
          h('span', { className: 'dshgc-top-label' }, t('header.project')),
          h('select', {
            id: 'dshgc-project-select',
            className: 'dshgc-select',
            value: projectOptions.some(option => option.path === cwd) ? cwd : '',
            onChange: chooseProject,
            disabled: projectOptions.length <= 1,
            title: cwd,
            'aria-label': t('header.project'),
          },
            projectOptions.length === 0
              ? h('option', { value: '' }, discovered === undefined ? t('header.searching') : t('header.noRepos'))
              : [
                ...projectOptions.map(option => h('option', { key: option.path, value: option.path }, option.name)),
                ...(discovered?.truncated === true ? [h('option', { key: '__truncated', value: '', disabled: true }, t('header.truncated'))] : []),
              ],
          ),
          branchText !== '' ? h('span', { className: 'dshgc-top-sep' }) : null,
          branchText !== ''
            ? h('span', { className: 'dshgc-top-label' }, t('header.branch'))
            : null,
          branchText !== '' ? h('div', { className: 'dshgc-branch-wrap', ref: branchWrapRef },
            h('button', {
              type: 'button',
              className: `dshgc-pill dshgc-pill-button${branchOpen ? ' dshgc-pill-open' : ''}`,
              title: view?.repo?.root ?? '',
              'aria-label': t('branch.button'),
              'aria-expanded': branchOpen,
              disabled: opBusy,
              onClick: openBranchPopup,
            },
              h('span', { className: 'dshgc-branch-mark', 'aria-hidden': 'true' }, h(BranchIcon)),
              h('span', { className: 'dshgc-pill-text' }, branchText),
              h(Chevron, { open: branchOpen }),
            ),
            branchOpen ? renderBranchPopup({
              t,
              data: branchData,
              loading: branchLoading,
              query: branchQuery,
              expanded: branchExpanded,
              busy: opBusy,
              popRef: branchPopRef,
              activeRowRef: branchRowRef,
              onQuery: setBranchQuery,
              onToggle: setBranchExpanded,
              onAction: runAction,
            }) : null,
            branchOpen
              ? renderBranchSubmenu({
                t,
                branch: findBranch(branchData, branchQuery, branchExpanded),
                data: branchData,
                busy: opBusy,
                subRef: branchSubRef,
                onAction: runAction,
              })
              : null,
          ) : null,
          view?.repo?.ahead > 0 ? h('span', { className: 'dshgc-pill dshgc-pill-dim' }, t('branch.ahead', { count: view.repo.ahead })) : null,
          view?.repo?.behind > 0 ? h('span', { className: 'dshgc-pill dshgc-pill-dim' }, t('branch.behind', { count: view.repo.behind })) : null,
          view?.repo !== null && view?.repo !== undefined
            ? h('span', { className: 'dshgc-top-sep' })
            : null,
          view?.repo !== null && view?.repo !== undefined
            ? h('span', { className: 'dshgc-top-label' }, t('header.changes'))
            : null,
          view?.repo !== null && view?.repo !== undefined
            ? h('span', { className: 'dshgc-count' }, t('header.files', { count: files.length }))
            : null,
          h('div', { className: 'dshgc-top-grow' }),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('header.refresh'), 'aria-label': t('header.refresh'), 'data-tip': t('header.refresh'),
            onClick: () => { void refresh() }, disabled: loading || busy || cwd === '',
          }, h(RefreshIcon)),
        ),
        view?.repo !== null && view?.repo !== undefined ? h('div', { className: 'dshgc-toolbar' },
          h('span', { className: 'dshgc-toolbar-label' }, t('toolbar.label')),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip',
            title: t('toolbar.update'), 'aria-label': t('toolbar.update'), 'data-tip': t('toolbar.update'),
            disabled: busy || opBusy || cwd === '',
            onClick: () => { void runOp('pull', { strategy: prefs.updateStrategy }, t('sync.update'), false) },
          }, h(PullIcon)),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip',
            title: t('toolbar.push'), 'aria-label': t('toolbar.push'), 'data-tip': t('toolbar.push'),
            disabled: busy || opBusy || cwd === '',
            onClick: () => { void runOp('push', {}, t('sync.push'), false) },
          }, h(PushIcon)),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip',
            title: t('toolbar.remotes'), 'aria-label': t('toolbar.remotes'), 'data-tip': t('toolbar.remotes'),
            disabled: busy || opBusy || cwd === '',
            onClick: () => { void openRemotes() },
          }, h(RemoteIcon)),
          h('span', { className: 'dshgc-toolbar-sep' }),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('toolbar.rollback'), 'aria-label': t('toolbar.rollback'), 'data-tip': t('toolbar.rollback'),
            disabled: busy || selectedFiles.length === 0,
            onClick: () => setRollbackTarget({ paths: selectedFiles.map(file => file.path) }),
          }, h(RollbackIcon)),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('toolbar.showDiff'), 'aria-label': t('toolbar.showDiff'), 'data-tip': t('toolbar.showDiff'),
            disabled: busy || selectedPath === '',
            onClick: () => {
              const file = files.find(entry => entry.path === selectedPath)
              if (file !== undefined) void openPreview(file)
            },
          }, h(DiffIcon)),
          h('span', { className: 'dshgc-toolbar-sep' }),
          h('button', {
            type: 'button', className: `dshgc-icon-button dshgc-tip ${groupByDir ? 'dshgc-icon-button-on' : ''}`,
            title: t('toolbar.group'), 'aria-label': t('toolbar.group'), 'data-tip': t('toolbar.group'), 'aria-pressed': groupByDir,
            onClick: () => setGroupByDir(value => !value),
          }, h(GroupIcon)),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('toolbar.expandAll'), 'aria-label': t('toolbar.expandAll'), 'data-tip': t('toolbar.expandAll'),
            onClick: expandAllDirs,
          }, h(ExpandIcon)),
          h('button', {
            type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('toolbar.collapseAll'), 'aria-label': t('toolbar.collapseAll'), 'data-tip': t('toolbar.collapseAll'),
            onClick: collapseAllDirs,
          }, h(CollapseIcon)),
          h('span', { className: 'dshgc-toolbar-sep' }),
          h('div', { className: 'dshgc-settings-wrap' },
            h('button', {
              type: 'button', className: `dshgc-icon-button dshgc-tip ${settingsOpen ? 'dshgc-icon-button-on' : ''}`,
              title: t('toolbar.settings'), 'aria-label': t('toolbar.settings'), 'data-tip': t('toolbar.settings'), 'aria-expanded': settingsOpen,
              onClick: () => setSettingsOpen(value => !value),
            }, h(GearIcon)),
            settingsOpen ? h('div', { className: 'dshgc-popover', role: 'group', 'aria-label': t('settings.title') },
              h('label', { className: 'dshgc-pref' },
                h('input', { type: 'checkbox', checked: prefs.autoRefresh, onChange: event => updatePref('autoRefresh', event.target.checked) }),
                h('span', null, t('settings.autoRefresh')),
              ),
              h('label', { className: 'dshgc-pref' },
                h('input', { type: 'checkbox', checked: prefs.selectByDefault, onChange: event => updatePref('selectByDefault', event.target.checked) }),
                h('span', null, t('settings.selectByDefault')),
              ),
              h('label', { className: 'dshgc-pref dshgc-pref-row' },
                h('span', null, t('settings.update')),
                h('select', {
                  className: 'dshgc-select dshgc-select-tight',
                  value: prefs.updateStrategy,
                  'aria-label': t('settings.update'),
                  onChange: event => updatePref('updateStrategy', event.target.value),
                },
                  h('option', { value: 'merge' }, t('settings.update.merge')),
                  h('option', { value: 'rebase' }, t('settings.update.rebase')),
                  h('option', { value: 'ff-only' }, t('settings.update.ffOnly')),
                ),
              ),
            ) : null,
          ),
          // Only the conversation seat can hand the view back to Chat; the
          // sidebar tab has its own close control, so no dead button here.
          typeof props.openView === 'function'
            ? h('button', {
              type: 'button', className: 'dshgc-icon-button dshgc-tip', title: t('toolbar.close'), 'aria-label': t('toolbar.close'), 'data-tip': t('toolbar.close'),
              onClick: () => { props.openView('chat') },
            }, h(CloseIcon))
            : null,
        ) : null,
        loadError !== '' && data !== null
          ? h('div', { className: 'dshgc-banner dshgc-banner-error' }, t('error.load', { message: loadError }))
          : null,
        view?.repo?.state !== null && view?.repo?.state !== undefined && view?.repo?.state !== ''
          ? h('div', { className: 'dshgc-banner dshgc-banner-warn' },
            h('span', { className: 'dshgc-banner-text' }, t(`state.${view.repo.state}`)),
            view.repo.state === 'merge' || view.repo.state === 'rebase'
              ? h('button', {
                type: 'button',
                className: 'dshgc-secondary',
                disabled: busy || opBusy,
                onClick: () => { void runOp(view.repo.state, { action: 'continue' }, t('state.continue'), false) },
              }, t('state.continue'))
              : null,
            view.repo.state === 'merge' || view.repo.state === 'rebase'
              ? h('button', {
                type: 'button',
                className: 'dshgc-secondary',
                disabled: busy || opBusy,
                onClick: () => { void runOp(view.repo.state, { action: 'abort' }, t('state.abort'), false) },
              }, t('state.abort'))
              : null,
          )
          : null,
        h('div', { className: 'dshgc-body' }, renderBody({
          cwd, data: view, files, loadError, t, selected, toggleSelected, toggleSection,
          groupByDir, collapsedDirs, toggleDir, busy, initRepository, retry: () => { void refresh() },
          collapsedSections, toggleSectionCollapse,
          selectedPath, preview, openPreview,
          splitRatio, diffBoxRef, leftPaneRef, rightPaneRef, startSplitDrag, syncPaneScroll,
          listWidth, splitRef, startListDrag,
          saveState, editBodyRef, editGutterRef, onEditInput,
        })),
        notice !== null
          ? h('div', {
            className: `dshgc-notice-bar ${notice.kind === 'error' ? 'dshgc-notice-error' : 'dshgc-notice-ok'}`,
            role: notice.kind === 'error' ? 'alert' : 'status',
          }, notice.text)
          : null,
        view?.repo !== null && view?.repo !== undefined && files.length > 0 ? h('footer', { className: 'dshgc-commit' },
          h('div', { className: 'dshgc-commit-row' },
            h('label', { className: 'dshgc-check' },
              h('input', {
                ref: allCheckRef,
                type: 'checkbox', checked: allSelected, onChange: toggleAll,
                'aria-label': allSelected ? t('list.unselectAll') : t('list.selectAll'),
                disabled: files.length === 0,
              }),
              h('span', null, t('list.all')),
            ),
            h('span', { className: 'dshgc-commit-count' }, t('commit.count', { count: selectedFiles.length, total: files.length })),
          ),
          h('textarea', {
            ref: textareaRef,
            className: 'dshgc-textarea',
            placeholder: t('commit.placeholder'),
            value: message,
            rows: 3,
            spellCheck: false,
            onChange: event => { setMessage(event.target.value); if (notice?.kind === 'error') setNotice(null) },
          }),
          h('div', { className: 'dshgc-commit-actions' },
            h('button', {
              type: 'button',
              className: 'dshgc-primary',
              disabled: !canCommit,
              onClick: () => { void submit(false) },
            }, busy ? t('commit.submitting') : t('commit.submit')),
            h('button', {
              type: 'button',
              className: 'dshgc-secondary',
              disabled: !canCommit,
              onClick: () => { void submit(true) },
            }, busy ? t('pushing') : t('commit.push')),
          ),
          h('p', { className: 'dshgc-hint' }, t('commit.hint')),
        ) : null,
        renderBranchDialog({
          t,
          dialog,
          busy: opBusy,
          onField: editDialog,
          onRow: editRemoteRow,
          onSubmit: submitDialog,
          onCancel: () => { setDialog(null) },
        }),
        rollbackTarget !== null ? h('div', {
          className: 'dshgc-modal-mask',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('rollback.title'),
          onClick: () => setRollbackTarget(null),
          onKeyDown: (event) => { if (event.key === 'Escape') setRollbackTarget(null) },
        },
          h('div', { className: 'dshgc-modal', onClick: event => event.stopPropagation() },
            h('div', { className: 'dshgc-modal-title' }, t('rollback.title')),
            h('div', { className: 'dshgc-modal-body' }, t('rollback.body', { count: rollbackTarget.paths.length })),
            h('ul', { className: 'dshgc-modal-list' },
              rollbackTarget.paths.slice(0, 12).map(path => h('li', { key: path }, path)),
              rollbackTarget.paths.length > 12 ? h('li', { className: 'dshgc-modal-more' }, `… +${rollbackTarget.paths.length - 12}`) : null,
            ),
            h('div', { className: 'dshgc-modal-actions' },
              h('button', { type: 'button', className: 'dshgc-secondary', onClick: () => setRollbackTarget(null) }, t('rollback.cancel')),
              h('button', { type: 'button', className: 'dshgc-danger', onClick: () => { void runRollback() } }, t('rollback.confirm')),
            ),
          ),
        ) : null,
      )
    }

    /**
     * Render the state-dependent middle area.
     * @param {object} view - panel view model.
     * @returns {React.ReactNode} body content.
     */
    function renderBody(view) {
      const {
        cwd, data, files, loadError, t, selected, toggleSelected, toggleSection,
        groupByDir, collapsedDirs, toggleDir, busy, retry, initRepository, collapsedSections, toggleSectionCollapse,
        selectedPath, preview, openPreview, splitRatio, diffBoxRef, leftPaneRef, rightPaneRef,
        startSplitDrag, syncPaneScroll, listWidth, splitRef, startListDrag,
        saveState, editBodyRef, editGutterRef, onEditInput,
      } = view
      if (cwd === '') {
        return emptyState(t('empty.noProject.title'), t('empty.noProject.body'))
      }
      if (data === null || data === undefined) {
        if (loadError !== '') {
          return h('div', { className: 'dshgc-empty' },
            h('div', { className: 'dshgc-empty-mark', 'aria-hidden': 'true' }, h(PanelIcon, { size: 28 })),
            h('div', { className: 'dshgc-empty-title' }, t('empty.loadError.title')),
            h('div', { className: 'dshgc-empty-body' }, loadError),
            h('button', { type: 'button', className: 'dshgc-retry', onClick: retry }, t('empty.retry')),
          )
        }
        return h('div', { className: 'dshgc-loading' }, h('span', { className: 'dshgc-spinner' }))
      }
      if (data.repo === null) {
        if (data.reason === 'git-unavailable') {
          return emptyState(t('empty.gitMissing.title'), t('empty.gitMissing.body'))
        }
        return h('div', { className: 'dshgc-empty' },
          h('div', { className: 'dshgc-empty-mark', 'aria-hidden': 'true' }, h(PanelIcon, { size: 28 })),
          h('div', { className: 'dshgc-empty-title' }, t('empty.noRepo.title')),
          h('div', { className: 'dshgc-empty-body' }, t('empty.noRepo.body', { path: cwd })),
          h('button', {
            type: 'button',
            className: 'dshgc-retry dshgc-init-button',
            disabled: busy,
            onClick: () => { void initRepository() },
          }, busy ? t('empty.noRepo.initializing') : t('empty.noRepo.init')),
        )
      }
      if (files.length === 0) {
        return emptyState(t('empty.clean.title'), t('empty.clean.body'))
      }

      const { changes, unversioned } = splitFiles(files)

      /**
       * One section: a select-all checkbox in the header, then the rows.
       * @param {string} title - localized section title.
       * @param {Array<object>} entries - files of this section.
       * @param {string} key - React key.
       * @returns {React.ReactNode} section block.
       */
      const sectionOf = (title, entries, key) => {
        if (entries.length === 0) return null
        const chosen = entries.filter(file => selected.has(file.path)).length
        const all = chosen === entries.length
        const some = chosen > 0 && !all
        const collapsed = collapsedSections.has(key)
        // The group is a node of the tree itself: its children indent one
        // level deeper, and folding it hides them.
        const rows = collapsed ? null : (groupByDir
          ? buildTree(entries, collapsedDirs).map(row => row.kind === 'dir'
            ? h('div', {
              key: `dir:${row.key}`,
              className: 'dshgc-dirrow',
              style: { paddingLeft: `${6 + (row.depth + 1) * 14}px` },
              role: 'button',
              tabIndex: 0,
              'aria-expanded': !collapsedDirs.has(row.key),
              onClick: () => toggleDir(row.key),
              onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDir(row.key) } },
            },
              h(Chevron, { open: !collapsedDirs.has(row.key) }),
              h('span', { className: 'dshgc-dirname' }, row.label),
              h('span', { className: 'dshgc-dircount' }, String(row.files.length)),
            )
            : fileRow(row.file, row.depth + 1))
          : entries.map(file => fileRow(file, 1)))
        return h('div', { className: 'dshgc-section', key },
          h('div', { className: 'dshgc-section-head' },
            h('input', {
              type: 'checkbox',
              className: 'dshgc-section-check',
              checked: all,
              // A partially selected section reads as indeterminate, the way
              // an IDE group checkbox does.
              ref: node => { if (node !== null) node.indeterminate = some },
              disabled: busy,
              onChange: () => toggleSection(entries, !all),
              'aria-label': title,
            }),
            h('button', {
              type: 'button',
              className: 'dshgc-section-toggle',
              'aria-expanded': !collapsed,
              title,
              onClick: () => toggleSectionCollapse(key),
            },
              h(Chevron, { open: !collapsed }),
              h('span', { className: 'dshgc-section-title' }, title),
              h('span', { className: 'dshgc-count' }, t('header.files', { count: entries.length })),
            ),
          ),
          rows,
        )
      }

      /**
       * One file row: the checkbox owns selection, the label opens the preview.
       * @param {object} file - status entry.
       * @param {number} depth - tree depth for indentation.
       * @returns {React.ReactNode} row.
       */
      const fileRow = (file, depth) => h('div', {
        key: file.path,
        className: `dshgc-row ${selectedPath === file.path ? 'dshgc-row-open' : ''}`,
        style: { paddingLeft: `${6 + depth * 14}px` },
      },
        h('input', {
          type: 'checkbox',
          className: 'dshgc-row-check',
          checked: selected.has(file.path),
          disabled: busy,
          onChange: () => toggleSelected(file.path),
          'aria-label': file.path,
        }),
        h('button', {
          type: 'button',
          className: 'dshgc-row-main',
          'aria-label': `${file.name ?? file.path} — ${statusLabel(file.kind, t)}`,
          title: file.origPath !== null && file.origPath !== undefined ? `${file.origPath} → ${file.path}` : file.path,
          onClick: () => { void openPreview(file) },
        },
          h('span', { className: `dshgc-code dshgc-code-${file.kind}`, title: statusLabel(file.kind, t), 'aria-hidden': 'true' }, statusCode(file)),
          h('span', { className: 'dshgc-path' },
            groupByDir
              ? h('span', { className: 'dshgc-path-name' }, file.name ?? file.path)
              : pathParts(file.path, t),
            file.index !== '.' && file.worktree !== '.'
              ? h('span', { className: 'dshgc-partial', title: t('list.partialHint') }, t('list.partial'))
              : null,
            file.touched === true
              ? h('span', { className: 'dshgc-touched', title: t('list.touched') }, t('list.touched'))
              : null,
          ),
          h('span', { className: 'dshgc-stat', 'aria-hidden': 'true' },
            file.additions > 0 ? h('span', { className: 'dshgc-add-stat' }, `+${file.additions}`) : null,
            file.deletions > 0 ? h('span', { className: 'dshgc-del-stat' }, `−${file.deletions}`) : null,
          ),
        ),
      )

      return h('div', {
        className: 'dshgc-split',
        ref: splitRef,
        // An unset width leaves the CSS default in charge; a drag takes over.
        style: listWidth === null || listWidth === undefined ? null : { '--dshgc-list-width': `${listWidth}px` },
      },
        h('div', { className: 'dshgc-listcol' },
          h('div', { className: 'dshgc-list' },
            sectionOf(t('section.changes'), changes, 'changes'),
            sectionOf(t('section.unversioned'), unversioned, 'unversioned'),
          ),
        ),
        h('div', {
          className: 'dshgc-splitter dshgc-list-split',
          role: 'separator',
          'aria-orientation': 'vertical',
          title: t('list.resize'),
          onMouseDown: startListDrag,
        }),
        h('div', { className: 'dshgc-previewcol' }, renderPreview({
          preview, t, splitRatio, diffBoxRef, leftPaneRef, rightPaneRef, startSplitDrag, syncPaneScroll,
          saveState, editBodyRef, editGutterRef, onEditInput,
        })),
      )
    }

    /**
     * The right-hand pane: the selected file's change, or a hint.
     * @param {object} view - preview state, split ratio, pane refs and handlers.
     * @returns {React.ReactNode} pane content.
     */
    function renderPreview({
      preview, t, splitRatio, diffBoxRef, leftPaneRef, rightPaneRef, startSplitDrag, syncPaneScroll,
      saveState, editBodyRef, editGutterRef, onEditInput,
    }) {
      if (preview === null) {
        return h('div', { className: 'dshgc-preview-empty' }, t('preview.hint'))
      }
      if (preview.loading === true) {
        return h('div', { className: 'dshgc-preview-empty' }, h('span', { className: 'dshgc-spinner' }))
      }
      if (preview.error) {
        return h('div', { className: 'dshgc-preview-empty dshgc-preview-error' }, preview.error)
      }
      if (preview.kind === 'binary') {
        return h('div', { className: 'dshgc-preview-empty' }, t('diff.binary'))
      }
      if (preview.kind === 'tooLarge') {
        return h('div', { className: 'dshgc-preview-empty' }, t('diff.tooLarge'))
      }
      const rows = Array.isArray(preview.rows) ? preview.rows : []
      const head = h('div', { className: 'dshgc-preview-head' },
        h('span', { className: 'dshgc-preview-path', title: preview.path }, preview.path),
        h('span', { className: 'dshgc-preview-stats' },
          preview.additions > 0 ? h('span', { className: 'dshgc-add-stat' }, `+${preview.additions}`) : null,
          preview.deletions > 0 ? h('span', { className: 'dshgc-del-stat' }, `−${preview.deletions}`) : null,
        ),
        preview.truncated === true ? h('span', { className: 'dshgc-preview-note' }, t('diff.truncated')) : null,
      )

      /**
       * The working-tree side as one always-editable body: a block per file
       * line keeps the diff's colours, while deleted-line and hunk rows stay
       * as non-editable placeholders so both columns remain aligned. The
       * browser owns the DOM from the first keystroke on; the gutter and the
       * autosave only ever read it back, never re-paint it.
       * @param {Array<object>} diffRows - aligned rows.
       * @returns {React.ReactNode} the scrollable editor.
       */
      const editWrap = (diffRows) => {
        const editable = preview.truncated !== true
        const nodes = diffRows.map((row, index) => {
          if (row.type === 'ctx' || row.type === 'mod' || row.type === 'add') {
            return h('div', {
              key: index,
              className: `dshgc-editline dshgc-editline-${row.type === 'ctx' ? 'ctx' : 'add'}`,
              'data-row': index,
            }, row.newText ?? '')
          }
          if (row.type === 'del') {
            return h('div', { key: index, className: 'dshgc-editline dshgc-editline-void', contentEditable: false, 'data-row': index }, '')
          }
          return h('div', { key: index, className: 'dshgc-editline dshgc-editline-hunk', contentEditable: false, 'data-row': index }, row.text ?? '')
        })
        // git omits trailing blank context lines; the file still has them.
        const extra = Number.isInteger(preview.extraLines) ? preview.extraLines : 0
        for (let k = 0; k < extra; k += 1) {
          nodes.push(h('div', { key: `tail-${k}`, className: 'dshgc-editline dshgc-editline-ctx', 'data-row': diffRows.length + k }, ''))
        }
        return h('div', { className: 'dshgc-edit-wrap', key: preview.path },
          h('div', { className: 'dshgc-gutter', 'aria-hidden': 'true', ref: editGutterRef }),
          h('div', {
            className: 'dshgc-editbody',
            ref: editBodyRef,
            contentEditable: editable ? 'plaintext-only' : false,
            suppressContentEditableWarning: true,
            spellCheck: false,
            'aria-label': t('edit.area'),
            onInput: onEditInput,
          }, nodes),
        )
      }

      // An untracked file has no previous version: one full-width column.
      if (preview.untracked === true) {
        return h('div', { className: 'dshgc-preview' },
          head,
          h('div', { className: 'dshgc-pane dshgc-pane-single' },
            h('div', { className: 'dshgc-pane-head' },
              h('span', { className: 'dshgc-pane-title' }, t('preview.new')),
              h('span', { className: 'dshgc-pane-ref' }, t('preview.untrackedFile')),
              h('span', { className: 'dshgc-pane-head-grow' }),
              saveState === 'saving'
                ? h('span', { className: 'dshgc-pane-note' }, t('edit.saving'))
                : saveState === 'saved'
                  ? h('span', { className: 'dshgc-pane-note' }, t('edit.saved'))
                  : null,
            ),
            h('div', {
              className: 'dshgc-pane-scroll',
              ref: rightPaneRef,
              onScroll: event => syncPaneScroll('right', event),
            },
              editWrap(rows),
            ),
          ),
        )
      }

      /**
       * Ticks for the pane's scroll rail, one per changed block.
       * @param {Array<object>} diffRows - aligned rows.
       * @param {'left'|'right'} side - which version.
       * @param {string} tone - marker class.
       * @returns {React.ReactNode} the rail, or null without changes.
       */
      const changeMarks = (diffRows, side, tone) => {
        const blocks = []
        diffRows.forEach((row, index) => {
          const changed = side === 'left'
            ? row.type === 'del' || row.type === 'mod'
            : row.type === 'add' || row.type === 'mod'
          if (!changed) return
          const last = blocks[blocks.length - 1]
          if (last !== undefined && last.end === index - 1) last.end = index
          else blocks.push({ start: index, end: index })
        })
        if (blocks.length === 0) return null
        const total = Math.max(diffRows.length, 1)
        const jump = (start) => {
          const pane = side === 'left' ? leftPaneRef.current : rightPaneRef.current
          const node = pane === null || pane === undefined
            ? null
            : pane.querySelector(`[data-row="${start}"]`)
          if (node !== null && node !== undefined) node.scrollIntoView({ block: 'center' })
        }
        return h('div', { className: 'dshgc-marks', 'aria-hidden': 'true' },
          blocks.map((block, index) => h('div', {
            key: index,
            className: `dshgc-mark ${tone}`,
            style: { top: `${(block.start / total) * 100}%` },
            onMouseDown: () => jump(block.start),
          })),
        )
      }

      const leftShare = `${(splitRatio * 100).toFixed(2)}%`
      const rightShare = `${(100 - splitRatio * 100).toFixed(2)}%`
      return h('div', { className: 'dshgc-preview' },
        head,
        h('div', { className: 'dshgc-diff-box', ref: diffBoxRef },
          h('div', {
            className: 'dshgc-pane',
            style: { flexBasis: leftShare },
          },
            h('div', { className: 'dshgc-pane-head' },
              h('span', { className: 'dshgc-pane-title' }, t('preview.old')),
              h('span', { className: 'dshgc-pane-ref' }, preview.oldRef ? `HEAD ${preview.oldRef}` : t('preview.noBase')),
            ),
            h('div', { className: 'dshgc-pane-scroll', ref: leftPaneRef, onScroll: event => syncPaneScroll('left', event) },
              h('div', { className: 'dshgc-pane-body' }, renderLines(rows, 'left')),
            ),
            changeMarks(rows, 'left', 'dshgc-mark-del'),
          ),
          h('div', {
            className: 'dshgc-splitter',
            role: 'separator',
            'aria-orientation': 'vertical',
            title: t('preview.resize'),
            onMouseDown: startSplitDrag,
          }),
          h('div', {
            className: 'dshgc-pane',
            style: { flexBasis: rightShare },
          },
            h('div', { className: 'dshgc-pane-head' },
              h('span', { className: 'dshgc-pane-title' }, t('preview.new')),
              h('span', { className: 'dshgc-pane-ref' }, t('preview.workingTree')),
              h('span', { className: 'dshgc-pane-head-grow' }),
              saveState === 'saving'
                ? h('span', { className: 'dshgc-pane-note' }, t('edit.saving'))
                : saveState === 'saved'
                  ? h('span', { className: 'dshgc-pane-note' }, t('edit.saved'))
                  : null,
            ),
            // A deleted file has no current version: name that instead of
            // leaving an empty column.
            hasWorkingTreeContent(rows)
              ? h('div', {
                className: 'dshgc-pane-scroll',
                ref: rightPaneRef,
                onScroll: event => syncPaneScroll('right', event),
              },
                editWrap(rows),
              )
              : h('div', { className: 'dshgc-pane-scroll' },
                h('div', { className: 'dshgc-pane-note' }, t('preview.deleted')),
              ),
            changeMarks(rows, 'right', 'dshgc-mark-add'),
          ),
        ),
      )
    }

    /**
     * Whether the working tree still has any line of this file.
     * @param {Array<object>} rows - aligned diff rows.
     * @returns {boolean} true when at least one row exists on the new side.
     */
    function hasWorkingTreeContent(rows) {
      return rows.some(row => row.type === 'ctx' || row.type === 'add' || row.type === 'mod')
    }

    /**
     * Rows of one version, keeping the other side's line slots so the two
     * columns stay aligned on the same logical row.
     * @param {Array<object>} rows - aligned diff rows.
     * @param {'left' | 'right'} side - which version to draw.
     * @returns {Array<React.ReactNode>} line nodes.
     */
    function renderLines(rows, side) {
      const isOld = side === 'left'
      return rows.map((row, index) => {
        if (row.type === 'hunk' || row.type === 'meta') {
          return h('div', { key: index, className: `dshgc-line dshgc-line-${row.type}`, 'data-row': index },
            h('span', { className: 'dshgc-line-no' }, ''),
            h('span', { className: 'dshgc-line-code' }, row.text ?? ''),
          )
        }
        const number = isOld ? row.oldNo : row.newNo
        const text = isOld ? row.oldText : row.newText
        if (number === undefined || number === null) {
          return h('div', { key: index, className: 'dshgc-line dshgc-line-void', 'data-row': index },
            h('span', { className: 'dshgc-line-no' }, ''),
            h('span', { className: 'dshgc-line-code' }, ''),
          )
        }
        const tone = row.type === 'ctx' ? 'ctx' : row.type === 'mod' ? (isOld ? 'del' : 'add') : row.type
        return h('div', {
          key: index,
          className: `dshgc-line dshgc-line-${tone}`,
          'data-row': index,
          'data-newline': isOld ? undefined : number,
        },
          h('span', { className: 'dshgc-line-no' }, String(number)),
          h('span', { className: 'dshgc-line-code' }, text ?? ''),
        )
      })
    }

    /**
     * Render one path with its directory part subdued.
     * @param {string} path - repository-relative path.
     * @param {function} _t - translate function (unused; kept for symmetry).
     * @returns {React.ReactNode} path text.
     */
    function pathParts(path, _t) {
      const index = path.lastIndexOf('/')
      if (index < 0) return h('span', { className: 'dshgc-path-name' }, path)
      return [
        h('span', { key: 'dir', className: 'dshgc-path-dir' }, path.slice(0, index + 1)),
        h('span', { key: 'name', className: 'dshgc-path-name' }, path.slice(index + 1)),
      ]
    }

    /**
     * Centered empty/error state.
     * @param {string} title - headline.
     * @param {string} body - explanation.
     * @returns {React.ReactNode} block.
     */
    function emptyState(title, body) {
      return h('div', { className: 'dshgc-empty' },
        h('div', { className: 'dshgc-empty-mark', 'aria-hidden': 'true' }, h(PanelIcon, { size: 28 })),
        h('div', { className: 'dshgc-empty-title' }, title),
        h('div', { className: 'dshgc-empty-body' }, body),
      )
    }

    const icon = (paths, size) => h('svg', { width: size ?? 15, height: size ?? 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, ...paths)

    /** Rollback (undo arrow) glyph. */
    function RollbackIcon() {
      return icon([
        h('path', { d: 'M6 4.5 2.8 7.5 6 10.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M2.8 7.5h6.4a3.3 3.3 0 0 1 0 6.6H7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Show-diff (two panes) glyph. */
    function DiffIcon() {
      return icon([
        h('rect', { x: 1.8, y: 2.6, width: 5.4, height: 10.8, rx: 1, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('rect', { x: 8.8, y: 2.6, width: 5.4, height: 10.8, rx: 1, stroke: 'currentColor', strokeWidth: 1.4 }),
      ])
    }

    /** Group-by-directory glyph. */
    function GroupIcon() {
      return icon([
        h('path', { d: 'M2.4 3.6h3l1.2 1.6h7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M2.4 3.6v9.4h11.2V6.8H7.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ])
    }

    /** Expand-all glyph. */
    function ExpandIcon() {
      return icon([
        h('path', { d: 'M8 2.6 4.6 6h6.8L8 2.6Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 13.4 4.6 10h6.8l-3.4 3.4Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      ])
    }

    /** Collapse-all glyph. */
    function CollapseIcon() {
      return icon([
        h('path', { d: 'M8 6.4 4.6 3h6.8L8 6.4Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 9.6 4.6 13h6.8L8 9.6Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      ])
    }

    /** Settings (gear) glyph. */
    function GearIcon() {
      return icon([
        h('circle', { cx: 8, cy: 8, r: 2.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      ])
    }

    /** Close (x) glyph. */
    function CloseIcon() {
      return icon([
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Chevron glyph for tree rows. */
    function Chevron({ open }) {
      return h('svg', {
        className: `dshgc-chevron ${open ? 'dshgc-chevron-open' : ''}`,
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
        h('path', {
          d: 'M6 3.5 10.5 8 6 12.5',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Small refresh glyph. */
    function RefreshIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.55-3.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M13.5 2.6v3.1h-3.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** Git branch glyph, the head of the branch popup's button. */
    function BranchIcon() {
      return icon([
        h('path', { d: 'M5 4.4v7.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M11.4 6.6c0 2.3-2.3 2.9-4.4 3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 5, cy: 3, r: 1.4, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 5, cy: 13, r: 1.4, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 11.4, cy: 4.6, r: 1.4, stroke: 'currentColor', strokeWidth: 1.4 }),
      ])
    }

    /** Pull / update glyph: an arrow down into a shelf. */
    function PullIcon() {
      return icon([
        h('path', { d: 'M8 2.4v6.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 6.4 8 9.2l2.8-2.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3 13h10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Push glyph: an arrow up out of a shelf. */
    function PushIcon() {
      return icon([
        h('path', { d: 'M8 13.6V7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 9.6 8 6.8l2.8 2.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3 3h10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Remote glyph: a link. */
    function RemoteIcon() {
      return icon([
        h('path', { d: 'M6.7 9.3 9.3 6.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M7.6 4.9 9 3.5a2.8 2.8 0 0 1 3.9 3.9l-1.4 1.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M8.4 11.1 7 12.5a2.8 2.8 0 0 1-3.9-3.9l1.4-1.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Tag glyph, for the revision picker. */
    function TagIcon() {
      return icon([
        h('path', { d: 'M3 7.4V3h4.4l5.6 5.6-4.4 4.4z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('circle', { cx: 5.5, cy: 5.5, r: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
      ])
    }

    /** Plus glyph, for adding a remote. */
    function PlusIcon() {
      return icon([
        h('path', { d: 'M8 3.6v8.8M3.6 8h8.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /** Minus glyph, for removing a remote. */
    function MinusIcon() {
      return icon([
        h('path', { d: 'M3.6 8h8.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    /**
     * Whether one row's text answers the popup's search box.
     * @param {string} needle - the lower-cased query.
     * @param {string} text - the row label.
     * @returns {boolean} whether to show it.
     */
    function matchesQuery(needle, text) {
      if (needle === '') return true
      return String(text ?? '').toLowerCase().includes(needle)
    }

    /**
     * Split the branch table by what the search box asked for.
     * @param {object | null} data - the host's `branches` answer.
     * @param {string} query - raw text from the search box.
     * @returns {{ local: object[], remote: object[], tags: object[] }} the kept rows.
     */
    function filterBranches(data, query) {
      const empty = { local: [], remote: [], tags: [] }
      if (data === null || data === undefined) return empty
      const needle = String(query ?? '').trim().toLowerCase()
      const keep = row => matchesQuery(needle, row.name)
      return {
        local: (Array.isArray(data.local) ? data.local : []).filter(keep),
        remote: (Array.isArray(data.remote) ? data.remote : []).filter(keep),
        tags: (Array.isArray(data.tags) ? data.tags : []).filter(keep),
      }
    }

    /**
     * The commands IDEA puts above the branch list in the same popup.
     * @param {object | null} data - the host's `branches` answer.
     * @param {(key: string, values?: object) => string} t - the dictionary.
     * @returns {Array<{ id: string, label: string }>} the command rows.
     */
    function syncActions(data, t) {
      const rows = [
        { id: 'update', label: t('sync.update') },
        { id: 'fetch', label: t('sync.fetch') },
        { id: 'push', label: t('sync.push') },
        { id: 'newBranch', label: t('branch.new') },
        { id: 'checkoutRev', label: t('branch.checkoutRev') },
        { id: 'remotes', label: t('sync.remotes') },
      ]
      if (data === null || data === undefined) return rows
      if (data.dirty === true) rows.push({ id: 'stash', label: t('sync.stash') })
      if (data.stash > 0) rows.push({ id: 'stashPop', label: t('sync.stashPop') })
      return rows
    }

    /**
     * The operations one branch row offers, the way IDEA's submenu does.
     * @param {object} branch - one row from the branch table.
     * @param {object} data - the host's `branches` answer.
     * @param {(key: string, values?: object) => string} t - the dictionary.
     * @returns {Array<{ id: string, label: string, danger?: boolean }>} the actions.
     */
    function branchActions(branch, data, t) {
      const current = typeof data.current === 'string' ? data.current : ''
      const isCurrent = branch.current === true
      const out = []
      // A detached HEAD can only move somewhere else; nothing merges into it.
      if (current === '') {
        out.push({ id: 'checkout', label: t('branch.checkout') })
        if (branch.kind === 'local') out.push({ id: 'newFrom', label: t('branch.newFrom', { ref: branch.name }) })
        out.push({ id: 'compare', label: t('branch.compare', { ref: branch.name }) })
        return out
      }
      // IDEA renames the item when the uncommitted work would have to travel.
      if (!isCurrent) {
        out.push({ id: 'checkout', label: t(data.dirty === true ? 'branch.checkoutSmart' : 'branch.checkout') })
      }
      if (branch.kind === 'local') {
        out.push({ id: 'newFrom', label: t('branch.newFrom', { ref: branch.name }) })
        if (isCurrent) {
          out.push({ id: 'update', label: t('branch.update') })
          out.push({ id: 'push', label: t('branch.push') })
          out.push({ id: 'tracking', label: t('branch.tracking') })
        } else {
          out.push({ id: 'merge', label: t('branch.merge', { ref: branch.name, current }) })
          out.push({ id: 'rebase', label: t('branch.rebase', { current, ref: branch.name }) })
          out.push({ id: 'rename', label: t('branch.rename') })
          out.push({ id: 'delete', label: t('branch.delete'), danger: true })
        }
        out.push({ id: 'compare', label: t('branch.compare', { ref: branch.name }) })
        return out
      }
      out.push({ id: 'compare', label: t('branch.compare', { ref: branch.name }) })
      if (!isCurrent) out.push({ id: 'merge', label: t('branch.merge', { ref: branch.name, current }) })
      if (branch.kind === 'remote') out.push({ id: 'trackAs', label: t('branch.trackingSet', { current }) })
      return out
    }

    /**
     * Look up the row the branch popup has selected, by its `kind:name` key.
     * @param {object | null} data - the host's `branches` answer.
     * @param {string} query - raw text from the search box.
     * @param {string} key - the active row key, or '' for none.
     * @returns {object | null} the row with its `kind`, or null.
     */
    function findBranch(data, query, key) {
      const separator = key.indexOf(':')
      if (data === null || separator < 0) return null
      const kind = key.slice(0, separator)
      const rows = filterBranches(data, query)[kind]
      if (!Array.isArray(rows)) return null
      const hit = rows.find(row => row.name === key.slice(separator + 1))
      return hit === undefined ? null : { ...hit, kind }
    }

    /**
     * Where the second-level menu belongs, measured against the panel it lives in.
     * @param {object} root - the panel's box.
     * @param {object} pop - the branch list's box.
     * @param {object} row - the active row's box.
     * @param {{ width: number, height: number }} sub - the menu's own size.
     * @returns {{ left: number, top: number }} the offset from the panel's top-left.
     */
    function submenuPlacement(root, pop, row, sub) {
      let left = pop.right - root.left + 6
      // No room beside the list: cover its right edge instead of leaving the panel.
      if (left + sub.width > root.width - 8) left = Math.max(8, pop.right - root.left - sub.width - 6)
      const bottom = pop.bottom - root.top - 8
      let top = row.top - root.top
      // A row near the foot of the list would push the menu past it.
      if (top + sub.height > bottom) top = Math.max(pop.top - root.top + 8, bottom - sub.height)
      return { left: Math.round(left), top: Math.round(top) }
    }

    /**
     * The second-level menu IDEA hangs beside the branch list.
     * @param {object} view - `t`, `branch`, `data`, `busy`, `subRef`, `onAction`.
     * @returns {object | null} the menu, or nothing while no row is active.
     */
    function renderBranchSubmenu(view) {
      const { t, branch, data, busy, subRef, onAction } = view
      if (branch === null || data === null) return null
      const actions = branchActions(branch, data, t)
      if (actions.length === 0) return null
      return h('div', { className: 'dshgc-branch-submenu', role: 'menu', 'aria-label': branch.name, ref: subRef },
        ...actions.map(action => h('button', {
          key: action.id,
          type: 'button',
          role: 'menuitem',
          className: `dshgc-branch-op${action.danger === true ? ' dshgc-branch-op-danger' : ''}`,
          disabled: busy,
          onClick: () => { onAction(action, branch) },
        }, action.label)),
      )
    }

    /**
     * The branch popup: search box, commands, then the branch table.
     * @param {object} view - `t`, `data`, `loading`, `query`, `expanded`, `busy`,
     *   `popRef`, `activeRowRef`, `onQuery`, `onToggle`, `onAction`.
     * @returns {object} the popup.
     */
    function renderBranchPopup(view) {
      const { t, data, loading, query, expanded, busy, popRef, activeRowRef, onQuery, onToggle, onAction } = view
      const needle = String(query ?? '').trim().toLowerCase()
      const groups = filterBranches(data, query)
      const commands = syncActions(data, t).filter(op => matchesQuery(needle, op.label))
      const sections = []
      for (const kind of ['local', 'remote', 'tags']) {
        const rows = groups[kind]
        if (rows.length === 0) continue
        sections.push(h('div', { key: kind, className: 'dshgc-branch-group' },
          h('div', { className: 'dshgc-branch-title' }, t(`branch.${kind}`)),
          ...rows.map(branch => {
            const key = `${kind}:${branch.name}`
            const open = expanded === key
            const actions = data === null ? [] : branchActions({ ...branch, kind }, data, t)
            // Hovering or focusing a row hands it to the submenu beside the list.
            return h('button', {
              key,
              ref: open ? activeRowRef : null,
              type: 'button',
              className: `dshgc-branch-row${open ? ' dshgc-branch-row-open' : ''}${branch.current === true ? ' dshgc-branch-row-on' : ''}`,
              'aria-expanded': open,
              title: branch.subject ?? '',
              onClick: () => { onToggle(open ? '' : key) },
              onMouseEnter: () => { onToggle(key) },
              onFocus: () => { onToggle(key) },
            },
              h('span', { className: 'dshgc-branch-mark', 'aria-hidden': 'true' }, h(BranchIcon)),
              h('span', { className: 'dshgc-branch-text' }, branch.name),
              kind === 'local' && branch.current === true
                ? h('span', { className: 'dshgc-branch-badge dshgc-branch-badge-on' }, t('branch.current'))
                : null,
              branch.upstream ? h('span', { className: 'dshgc-branch-sub' }, branch.upstream) : null,
              branch.ahead > 0 ? h('span', { className: 'dshgc-branch-badge' }, t('branch.ahead', { count: branch.ahead })) : null,
              branch.behind > 0 ? h('span', { className: 'dshgc-branch-badge' }, t('branch.behind', { count: branch.behind })) : null,
              branch.gone === true ? h('span', { className: 'dshgc-branch-badge dshgc-branch-gone' }, t('branch.gone')) : null,
              actions.length > 0 ? h('span', { className: 'dshgc-branch-more' }, h(Chevron, { open: false })) : null,
            )
          }),
        ))
      }
      const nothing = sections.length === 0 && commands.length === 0
      return h('div', { className: 'dshgc-branch-pop', role: 'dialog', 'aria-label': t('branch.menu'), ref: popRef },
        h('input', {
          className: 'dshgc-branch-search',
          type: 'search',
          placeholder: t('branch.search'),
          value: query ?? '',
          'aria-label': t('branch.search'),
          onChange: event => { onQuery(event.target.value) },
        }),
        loading === true && data === null
          ? h('div', { className: 'dshgc-branch-note' }, t('branch.loading'))
          : null,
        commands.length > 0
          ? h('div', { className: 'dshgc-branch-group dshgc-branch-group-top' },
            ...commands.map(op => h('button', {
              key: op.id,
              type: 'button',
              className: 'dshgc-branch-op dshgc-branch-command',
              disabled: busy,
              onClick: () => { onAction({ ...op, command: true }, null) },
            }, op.label)),
          )
          : null,
        ...sections,
        nothing ? h('div', { className: 'dshgc-branch-note' }, t('branch.empty')) : null,
      )
    }

    /**
     * Work out what to send git for one edited remote table.
     * @param {Array<{ name: string, url: string }>} original - the table as loaded.
     * @param {Array<{ name: string, url: string, originName: string }>} rows - the draft.
     * @returns {Array<object>} the `remote` payloads, in a safe order.
     */
    function diffRemotes(original, rows) {
      const ops = []
      const kept = new Map()
      for (const row of rows) {
        if (row.originName !== '') kept.set(row.originName, row)
      }
      for (const before of original) {
        const after = kept.get(before.name)
        if (after === undefined) {
          ops.push({ action: 'remove', name: before.name })
          continue
        }
        const renamed = after.name !== before.name
        if (renamed) ops.push({ action: 'rename', name: before.name, newName: after.name })
        if (after.url !== before.url) {
          ops.push({ action: 'set-url', name: renamed ? after.name : before.name, url: after.url })
        }
      }
      for (const row of rows) {
        if (row.originName === '' && row.name !== '') {
          ops.push({ action: 'add', name: row.name, url: row.url })
        }
      }
      return ops
    }

    /**
     * The popup's own dialogs: a prompt, a confirmation, the compare table,
     * and the remote manager. One function so the panel holds one piece of state.
     * @param {object} view - `t`, `dialog`, `busy`, `onField`, `onRow`, `onSubmit`, `onCancel`.
     * @returns {object | null} the modal, or nothing while no dialog is open.
     */
    function renderBranchDialog(view) {
      const { t, dialog, busy, onField, onRow, onSubmit, onCancel } = view
      if (dialog === null || dialog === undefined) return null
      const title = dialog.title ?? ''
      if (dialog.kind === 'remotes') {
        const rows = Array.isArray(dialog.rows) ? dialog.rows : []
        return h('div', { className: 'dshgc-modal-mask', role: 'dialog', 'aria-modal': true, 'aria-label': t('remote.title'), onClick: onCancel },
          h('div', { className: 'dshgc-modal dshgc-modal-wide', onClick: event => event.stopPropagation() },
            h('div', { className: 'dshgc-modal-title' }, t('remote.title')),
            dialog.loading === true ? h('div', { className: 'dshgc-branch-note' }, t('branch.loading')) : null,
            dialog.error ? h('div', { className: 'dshgc-banner dshgc-banner-error' }, dialog.error) : null,
            // A failed read leaves the rows empty, and "no remotes" on top of
            // the error would be a lie: the table was never read.
            rows.length === 0 && dialog.loading !== true && !dialog.error
              ? h('div', { className: 'dshgc-branch-note' }, t('remote.none'))
              : null,
            rows.length > 0 ? h('div', { className: 'dshgc-remote-head' },
              h('span', { className: 'dshgc-remote-head-name' }, t('remote.name')),
              h('span', null, t('remote.url')),
            ) : null,
            ...rows.map((row, index) => h('div', { key: index, className: 'dshgc-remote-row' },
              h('input', {
                className: 'dshgc-remote-name',
                value: row.name,
                'aria-label': t('remote.name'),
                placeholder: row.originName === '' ? t('remote.newName') : '',
                disabled: busy,
                onChange: event => { onRow(index, 'name', event.target.value) },
              }),
              h('input', {
                className: 'dshgc-remote-url',
                value: row.url,
                placeholder: 'https://…',
                spellCheck: false,
                'aria-label': t('remote.url'),
                onChange: event => { onRow(index, 'url', event.target.value) },
              }),
              h('button', {
                type: 'button',
                className: 'dshgc-icon-button dshgc-tip',
                title: t('remote.remove'),
                'aria-label': t('remote.remove'),
                'data-tip': t('remote.remove'),
                disabled: busy,
                onClick: () => { onRow(index, 'remove', '') },
              }, h(MinusIcon)),
            )),
            h('div', { className: 'dshgc-modal-actions dshgc-modal-actions-between' },
              h('button', {
                type: 'button', className: 'dshgc-secondary', disabled: busy,
                onClick: () => { onRow(-1, 'add', '') },
              }, t('remote.add')),
              h('div', { className: 'dshgc-modal-actions' },
                h('button', { type: 'button', className: 'dshgc-secondary', onClick: onCancel }, t('op.cancel')),
                h('button', {
                  type: 'button', className: 'dshgc-primary', disabled: busy || dialog.loading === true,
                  onClick: onSubmit,
                }, busy ? t('remote.saving') : t('op.confirm')),
              ),
            ),
          ),
        )
      }
      if (dialog.kind === 'compare') {
        const data = dialog.data
        const files = data === null || data === undefined ? [] : data.files
        const ahead = data === null || data === undefined ? [] : data.aheadCommits
        const behind = data === null || data === undefined ? [] : data.behindCommits
        return h('div', { className: 'dshgc-modal-mask', role: 'dialog', 'aria-modal': true, 'aria-label': title, onClick: onCancel },
          h('div', { className: 'dshgc-modal dshgc-modal-wide', onClick: event => event.stopPropagation() },
            h('div', { className: 'dshgc-modal-title' }, title),
            dialog.loading === true ? h('div', { className: 'dshgc-branch-note' }, t('compare.loading')) : null,
            dialog.error !== '' && dialog.error !== undefined
              ? h('div', { className: 'dshgc-banner dshgc-banner-error' }, dialog.error)
              : null,
            data === null || data === undefined ? null : h('div', { className: 'dshgc-compare-summary' },
              data.ahead === 0 && data.behind === 0 ? t('compare.same') : null,
              data.ahead > 0 ? h('div', null, t('compare.ahead', { ref: data.ref, count: data.ahead })) : null,
              data.behind > 0 ? h('div', null, t('compare.behind', { base: data.base, count: data.behind })) : null,
            ),
            data === null || data === undefined || ahead.length + behind.length === 0 ? null : h('div', { className: 'dshgc-compare-commits' },
              ...[...ahead, ...behind].map(commit => h('div', { key: commit.hash, className: 'dshgc-compare-commit' },
                h('span', { className: 'dshgc-compare-hash' }, commit.hash),
                h('span', null, commit.subject),
                h('span', { className: 'dshgc-branch-sub' }, `${commit.author} ${commit.date}`),
              )),
            ),
            data === null || data === undefined ? null : h('div', { className: 'dshgc-compare-files' },
              h('div', { className: 'dshgc-branch-title' }, t('compare.files')),
              files.length === 0 ? h('div', { className: 'dshgc-branch-note' }, t('compare.noFiles')) : null,
              ...files.slice(0, 200).map(entry => h('div', { key: `${entry.status}${entry.path}`, className: 'dshgc-compare-file' },
                h('span', {
                  className: `dshgc-code dshgc-code-${({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', U: 'conflict' })[entry.status] ?? 'modified'}`,
                }, entry.status),
                h('span', { className: 'dshgc-branch-text' }, entry.origPath === null ? entry.path : `${entry.origPath} -> ${entry.path}`),
              )),
            ),
            h('div', { className: 'dshgc-modal-actions' },
              h('button', { type: 'button', className: 'dshgc-secondary', onClick: onCancel }, t('op.close')),
            ),
          ),
        )
      }
      // prompt and confirm share the small form.
      const options = Array.isArray(dialog.select) ? dialog.select : null
      return h('div', { className: 'dshgc-modal-mask', role: 'dialog', 'aria-modal': true, 'aria-label': title, onClick: onCancel },
        h('div', { className: 'dshgc-modal', onClick: event => event.stopPropagation() },
          h('div', { className: 'dshgc-modal-title' }, title),
          dialog.body ? h('div', { className: 'dshgc-modal-body' }, dialog.body) : null,
          dialog.hint ? h('div', { className: 'dshgc-modal-body' }, dialog.hint) : null,
          options !== null
            ? h('select', {
              className: 'dshgc-select dshgc-dialog-input',
              value: dialog.value,
              'aria-label': dialog.label,
              onChange: event => { onField('value', event.target.value) },
            },
              h('option', { value: '' }, t('prompt.none')),
              ...options.map(option => h('option', { key: option, value: option }, option)),
            )
            : dialog.kind === 'confirm'
              ? null
              : h('input', {
                className: 'dshgc-dialog-input',
                value: dialog.value,
                placeholder: dialog.placeholder ?? '',
                spellCheck: false,
                autoFocus: true,
                'aria-label': dialog.label,
                onChange: event => { onField('value', event.target.value) },
                onKeyDown: event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  // The panel's own ⌘Enter handler must not run the dialog twice.
                  event.stopPropagation()
                  onSubmit()
                },
              }),
          h('div', { className: 'dshgc-modal-actions' },
            h('button', { type: 'button', className: 'dshgc-secondary', onClick: onCancel }, t('op.cancel')),
            h('button', {
              type: 'button',
              className: dialog.danger === true ? 'dshgc-danger' : 'dshgc-primary',
              disabled: busy || (dialog.kind === 'prompt' && String(dialog.value ?? '').trim() === ''),
              onClick: onSubmit,
            }, dialog.confirm ?? t('op.confirm')),
          ),
        ),
      )
    }

    /**
     * This plugin's configuration section on its 插件 page: one switch deciding
     * where the panel sits. It writes the entry's own configuration form, so the
     * choice lands in the active profile's cordis patch, every window follows it
     * as soon as the Host commits, and clearing it falls back to the row Config.
     * @param {object} props - slot props: the dictionary reader and the form.
     * @returns {object | null} the section, or nothing while there is nothing to show.
     */
    function GitCommitSettingsCard(props) {
      const t = props.t
      const scope = props.configForm
      const subscribe = useCallback(listener => scope.subscribe(listener), [scope])
      const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      /** Placement a write is crossing the wire, or '' once none is. */
      const [pending, setPending] = useState('')
      // An entry this client cannot configure (not active, or no volatile
      // fields) leaves no trace, exactly like the panels DSH ships.
      if (snapshot.status !== 'ready') return null
      const readOnly = snapshot.writable === false
      const asPlacement = (value) => (value === 'sidebar' ? 'sidebar' : 'tab')
      const placement = asPlacement(snapshot.value?.placement)
      const shown = pending === '' ? placement : pending
      const disabled = readOnly || pending !== ''
      const overridden = Object.hasOwn(snapshot.user ?? {}, 'placement')
      const options = [
        { value: 'tab', label: t('card.placement.tab') },
        { value: 'sidebar', label: t('card.placement.sidebar') },
      ]

      return h('div', { className: 'dshgc-card' },
        h('style', null, CSS),
        h('div', { className: 'dshgc-card-head' },
          h('div', { className: 'dshgc-card-title' }, t('card.title')),
          h('div', { className: 'dshgc-card-desc' }, t('card.description')),
        ),
        readOnly ? h('p', { className: 'dshgc-card-notice', role: 'status' }, t('card.readOnly')) : null,
        h('div', { className: 'dshgc-card-field' },
          h('div', { className: 'dshgc-card-labelrow' },
            h('span', { className: 'dshgc-card-label' }, t('card.placement')),
            overridden ? h('button', {
              type: 'button', className: 'dshgc-card-reset', disabled,
              onClick: () => {
                // Clearing falls back to the deployment's own row Config.
                setPending(asPlacement(snapshot.base?.placement))
                void scope.unset('placement').finally(() => setPending(''))
              },
            }, t('card.reset')) : null,
          ),
          h('div', { className: 'dshgc-seg', role: 'radiogroup', 'aria-label': t('card.placement') },
            ...options.map(option => h('button', {
              key: option.value,
              type: 'button',
              role: 'radio',
              'aria-checked': shown === option.value,
              disabled,
              className: shown === option.value ? 'dshgc-seg-btn dshgc-seg-btn-on' : 'dshgc-seg-btn',
              onClick: () => {
                if (shown === option.value || disabled) return
                setPending(option.value)
                void scope.set('placement', option.value).finally(() => setPending(''))
              },
            }, option.label)),
          ),
          h('p', { className: 'dshgc-card-hint' }, t('card.placementHint')),
        ),
      )
    }

    /**
     * Mount the panel where the `placement` setting says: a top tab beside
     * 对话/轨迹 (`tab`, the default) or a right-sidebar tab (`sidebar`). Both
     * seats are session-scoped, so each one shows that Session's project — no
     * per-open project picking. The tab hides itself while a finished workspace
     * scan finds no repository.
     *
     * The setting has two layers and one live channel: row Config is the
     * deployment default, the user's choice on the plugin's 插件 page overrides
     * it, and either way the panel moves the moment the value changes.
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git-commit: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.inject(['sessions'], (injected) => {
        const sessions = injected.get('sessions')
        if (sessions === undefined || sessions === null) return
        sessionsServiceRef = sessions
        cwdOfSession = (id) => {
          try {
            const row = sessions.list?.getSnapshot?.()?.byId?.[id]
            return typeof row?.cwd === 'string' ? row.cwd : ''
          } catch {
            return ''
          }
        }
        // A late session-list baseline must re-run discovery for the mounted
        // view's own scan root; membership alone can lag behind it.
        injected.effect(() => sessions.list.subscribe(() => {
          for (const wake of [...viewWakeups]) wake()
        }), 'dsh-git-commit: session list wakes views')
      })

      // The Workspace registry maps each Session to its scan root; every
      // membership change re-indexes and wakes mounted tabs through their
      // next discovery read.
      ctx.inject(['workspaces'], (injected) => {
        const workspaces = injected.get('workspaces')
        if (workspaces === undefined || workspaces === null) return
        const rebuild = () => {
          try {
            indexWorkspaces(workspaces.list.getSnapshot().items ?? [])
          } catch {
            /* keep the previous map */
          }
        }
        rebuild()
        injected.effect(() => workspaces.list.subscribe(rebuild), 'dsh-git-commit: workspace membership')
      })

      /** Seat the panel should take: 'tab', 'sidebar', or null while undecided. */
      let placement = null
      /** Which seat stands, and its disposer. */
      let seat = null
      let seatOff = null
      /** Context that has the right-sidebar services, null until they arrive. */
      let sidebarInjected = null
      /** Whether the configuration form has answered once; it outranks the Host read. */
      let settingsAnswered = false

      /**
       * Mount whatever `placement` now says, moving the panel if it changed.
       * Every source funnels through here — the Host answer at boot, every
       * settings commit, and the sidebar services arriving late — so the panel
       * holds exactly one seat.
       */
      const settle = () => {
        if (placement === null || placement === seat) return
        // A switch to the sidebar waits for that seat's services: a build with
        // no right sidebar never supplies them, and `tab` must not stall on it.
        if (placement === 'sidebar' && sidebarInjected === null) return
        seat = placement
        if (seatOff !== null) seatOff()
        const off = placement === 'sidebar'
          ? mountSidebarSeat(sidebarInjected, t)
          : mountTabSeat(ctx, t)
        if (off === null) {
          seat = null
          return
        }
        seatOff = off
      }

      // The browser half never sees row Config, so it asks the Host, which
      // answers with the placement resolved from every layer beneath the form.
      void readPlacement().then((value) => {
        if (settingsAnswered) return
        placement = value
        settle()
      })

      // The entry's configuration form is the live source: it mirrors what the
      // Host resolved, and every write goes back through the Host so the profile
      // patch and all other windows follow. Injected rather than declared, so a
      // deployment without the settings service keeps working on the Host answer
      // above.
      ctx.inject(['configForms'], (injected) => {
        const form = injected.configForms.get(ENTRY_ID)
        if (form === undefined || form === null) return
        const sync = () => {
          const snapshot = form.getSnapshot()
          if (snapshot.status !== 'ready') return
          settingsAnswered = true
          placement = snapshot.value?.placement === 'sidebar' ? 'sidebar' : 'tab'
          settle()
        }
        injected.effect(() => form.subscribe(sync), 'dsh-git-commit: placement changes')
        sync()
        registerConfigSection(injected, form)
      })

      // The right sidebar's services may not exist yet, and a build without a
      // sidebar never supplies them, so this injection only arms the sidebar
      // seat; the `tab` seat never waits on it.
      ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        injected.effect(() => {
          sidebarInjected = injected
          settle()
          return () => { sidebarInjected = null }
        }, 'dsh-git-commit: sidebar services')
      })
    }

    /**
     * Read the placement the Host resolved, which is the only source when no
     * configuration form reaches this client.
     * @returns {Promise<'tab' | 'sidebar'>} placement; `tab` on any failure.
     */
    async function readPlacement() {
      try {
        const data = await api('config', {})
        return data?.placement === 'sidebar' ? 'sidebar' : 'tab'
      } catch {
        return 'tab'
      }
    }

    /**
     * Contribute this plugin's configuration section to its bundle page on the
     * 插件 panel. The slot pairs a page with a bundle by package name alone, and
     * the page host shows the section only once something is registered under
     * that key, so this call is all it takes; the section owns its own controls.
     * @param {object} injected - context that has the configuration form and slots.
     * @param {object} form - the shared form for the `git-commit` entry.
     */
    function registerConfigSection(injected, form) {
      injected.slots.inject('plugins.bundle.config', () => injected.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_PKG,
        locale: NS,
        inject: () => ({ configForm: form }),
      }, GitCommitSettingsCard))
    }

    /**
     * Mount the panel beside 对话/轨迹, as a session-scoped conversation view.
     * @param {object} ctx - browser plugin context.
     * @param {function} t - translate this plugin's dictionary.
     * @returns {function} disposer for the seat.
     */
    function mountTabSeat(ctx, t) {
      return ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: VIEW_ID,
        order: 20,
        locale: NS,
        label: () => t('panel.title'),
        // Only values, never hooks: the view seat has no standard sources.
        inject: () => ({ viewSessionId: activeSessionId() ?? '' }),
      }, GitCommitPanel))
    }

    /**
     * Mount the panel in DSH's right sidebar: the tab type goes to the
     * `sidebarRightTabs` registry, its body into `sidebar.right.pane.tab`, and
     * the guide entry is the start-page capsule that opens it. The caller hands
     * in a context that already has the sidebar services, because apply can run
     * long before the sidebar provides them.
     * @param {object} injected - context that has the sidebar services.
     * @param {function} t - translate this plugin's dictionary.
     * @returns {function | null} disposer, or null when the seat is unavailable.
     */
    function mountSidebarSeat(injected, t) {
      const tabs = injected.get('sidebarRightTabs')
      const slots = injected.get('slots')
      if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return null
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') return null
      const offType = tabs.register({
        id: VIEW_ID,
        kind: VIEW_ID,
        title: () => t('panel.title'),
        guide: [{
          id: 'open',
          order: 30,
          title: () => t('panel.title'),
          description: () => t('guide.sidebar'),
        }],
      })
      const offBody = slots.inject('sidebar.right.pane.tab', () => slots.register(
        { name: 'sidebar.right.pane.tab', key: VIEW_ID },
        // This seat brings no locale kit, so the panel gets this plugin's
        // translator directly; a seat that does supply one keeps its own.
        (tabProps) => h(GitCommitPanel, Object.assign({}, tabProps, { t: tabProps?.t ?? t })),
      ))
      return () => {
        offBody()
        offType()
      }
    }

    const CSS = `
/* Fill the view band exactly: header at the top, commit box on the bottom
   edge, and the file/preview area takes every pixel in between. */
.dshgc-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;overflow:hidden;max-height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:var(--dsh-content-font-size,13px);line-height:1.5}
.dshgc-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dshgc-pill{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.dshgc-pill-dim{color:var(--dsw-alias-label-tertiary)}
.dshgc-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative}
/* Hover hint. A native title tooltip is easy to miss (and slow), so each icon
   carries its own label instead; it never captures the pointer. */
.dshgc-tip::after{content:attr(data-tip);position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);z-index:30;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:11px;line-height:1.4;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease;box-shadow:0 4px 12px rgba(0,0,0,.18)}
.dshgc-tip:hover::after,.dshgc-tip:focus-visible::after,.dshgc-tip:focus::after{opacity:1}
.dshgc-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshgc-icon-button:disabled{opacity:.4;cursor:default}
/* One line above the toolbar: project picker, then the selected project's
   branch and change count, with the refresh action pushed to the right. */
.dshgc-top{display:flex;align-items:center;gap:8px;padding:10px 14px 4px;min-width:0}
.dshgc-top-grow{flex:1 1 auto;min-width:0}
.dshgc-top-label{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dshgc-top-sep{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l1);margin:0 2px}
.dshgc-toolbar-label{flex:none;margin-right:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dshgc-toolbar{display:flex;align-items:center;gap:2px;padding:0 12px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
.dshgc-toolbar-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1);margin:0 6px}
.dshgc-icon-button-on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active)}
.dshgc-settings-wrap{position:relative;display:inline-flex}
.dshgc-popover{position:absolute;top:30px;left:0;z-index:20;display:flex;flex-direction:column;gap:8px;width:220px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.dshgc-pref{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshgc-pref input{accent-color:var(--dsw-alias-brand-primary)}
.dshgc-pref-row{justify-content:space-between;width:100%;gap:10px}
.dshgc-select-tight{min-width:0;width:120px;height:24px;font-size:11px;flex:none}
.dshgc-section{display:flex;flex-direction:column;margin-bottom:6px}
.dshgc-section-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshgc-section-check{flex:none;width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dshgc-section-toggle{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshgc-section-toggle:hover .dshgc-section-title{color:var(--dsw-alias-label-primary)}
.dshgc-dirrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;min-width:0;color:var(--dsw-alias-label-secondary)}
.dshgc-dirrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-dirname{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.dshgc-dircount{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshgc-modal-mask{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-scrim)}
.dshgc-root{position:relative}
.dshgc-modal{width:min(360px,90%);max-height:80%;overflow:auto;padding:16px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px}
.dshgc-modal-title{font-weight:600;font-size:14px}
.dshgc-modal-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshgc-modal-list{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-tertiary);max-height:160px;overflow:auto}
.dshgc-modal-more{list-style:none;color:var(--dsw-alias-label-tertiary)}
.dshgc-modal-actions{display:flex;justify-content:flex-end;gap:8px}
/* The branch pill opens the IDEA-style popup: search, commands, branch table. */
/* The wrap stays unpositioned so the popup anchors to the panel itself: a
   narrow panel then narrows the popup instead of clipping it. */
.dshgc-branch-wrap{display:inline-flex;min-width:0}
.dshgc-pill-button{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:220px;padding:1px 8px;border:1px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.dshgc-pill-button:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dshgc-pill-button:disabled{opacity:.5;cursor:default}
.dshgc-pill-open{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dshgc-pill-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshgc-branch-mark{display:inline-flex;flex:none;align-items:center}
.dshgc-branch-pop{position:absolute;top:44px;left:var(--dshgc-pop-left,14px);z-index:35;display:flex;flex-direction:column;gap:1px;width:var(--dshgc-pop-width,min(460px,calc(100% - 28px)));max-height:min(440px,62%);overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.dshgc-branch-search{width:100%;height:28px;margin-bottom:4px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dshgc-branch-search:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshgc-branch-group{display:flex;flex-direction:column;gap:1px;padding-top:5px;margin-top:5px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshgc-branch-group-top{padding-top:0;margin-top:0;border-top:0}
.dshgc-branch-title{padding:2px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshgc-branch-row{display:flex;align-items:center;gap:6px;width:100%;min-width:0;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dshgc-branch-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-branch-row-open{background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-branch-row-on{color:var(--dsw-alias-brand-primary)}
.dshgc-branch-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshgc-branch-sub{flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshgc-branch-badge{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshgc-branch-badge-on{color:var(--dsw-alias-brand-primary)}
.dshgc-branch-gone{color:var(--dsw-alias-state-error-primary)}
.dshgc-branch-note{padding:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
/* The row's operations float in a second menu beside the list, as in IDEA. */
.dshgc-branch-more{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshgc-branch-submenu{position:absolute;top:var(--dshgc-sub-top,44px);left:var(--dshgc-sub-left,100%);z-index:36;display:flex;flex-direction:column;gap:1px;min-width:220px;max-width:min(420px,calc(100% - 28px));max-height:min(440px,62%);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 28px rgba(0,0,0,.28)}
.dshgc-branch-op{padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshgc-branch-op:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshgc-branch-op:disabled{opacity:.45;cursor:default}
.dshgc-branch-op-danger{color:var(--dsw-alias-state-error-primary)}
/* A merge or rebase that stopped halfway must be visible, not guessed at. */
.dshgc-banner-warn{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
.dshgc-banner-text{flex:1 1 220px;min-width:0}
.dshgc-modal-wide{width:min(560px,94%)}
.dshgc-modal-actions-between{justify-content:space-between;width:100%}
.dshgc-dialog-input{width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dshgc-dialog-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
/* The remote table: name, URL, and one remove control per row. */
.dshgc-remote-head,.dshgc-remote-row{display:grid;grid-template-columns:120px minmax(0,1fr) 30px;gap:6px;align-items:center}
.dshgc-remote-head{padding:0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshgc-remote-name,.dshgc-remote-url{height:28px;min-width:0;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dshgc-remote-name:disabled{opacity:.6}
.dshgc-remote-name:focus,.dshgc-remote-url:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshgc-compare-summary{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshgc-compare-commits,.dshgc-compare-files{display:flex;flex-direction:column;gap:2px;max-height:170px;overflow:auto;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshgc-compare-commit,.dshgc-compare-file{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px}
.dshgc-compare-hash{flex:none;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-brand-primary)}
.dshgc-danger{height:28px;padding:0 14px;border:0;border-radius:7px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);font-size:13px;cursor:pointer}
.dshgc-secondary{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.dshgc-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-secondary:disabled{opacity:.45;cursor:default}
.dshgc-select{flex:0 1 auto;min-width:120px;max-width:260px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}
.dshgc-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshgc-body{flex:1 1 0;min-height:0;display:flex;overflow:hidden}
.dshgc-split{display:flex;flex:1 1 0;min-height:0;min-width:0;height:100%;overflow:hidden}
.dshgc-listcol{width:var(--dshgc-list-width,clamp(240px,42%,420px));min-width:200px;min-height:0;height:100%;overflow:auto;padding:0 8px 8px;box-sizing:border-box}
.dshgc-previewcol{flex:1 1 0;min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base)}
/* Narrow seat (the right sidebar): the file list rides over the diff instead of beside it. */
.dshgc-narrow .dshgc-split{flex-direction:column}
.dshgc-narrow .dshgc-listcol{width:auto;min-width:0;flex:0 0 40%;height:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshgc-narrow .dshgc-list-split{display:none}
.dshgc-narrow .dshgc-previewcol{flex:1 1 0;min-height:0}
.dshgc-list{display:flex;flex-direction:column;gap:1px}
.dshgc-row{display:flex;align-items:center;gap:8px;padding:3px 6px 3px 8px;border-radius:6px;min-width:0}
.dshgc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-row-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:2px 2px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshgc-row-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshgc-row-open{background:var(--dsw-alias-interactive-bg-active)}
.dshgc-row-check{flex:none;width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dshgc-code{flex:none;width:14px;text-align:center;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;font-weight:600}
.dshgc-code-modified{color:var(--dsw-alias-state-warn-primary)}
.dshgc-code-added,.dshgc-code-untracked{color:var(--dsw-alias-state-success-primary)}
.dshgc-code-deleted,.dshgc-code-conflict{color:var(--dsw-alias-state-error-primary)}
.dshgc-code-renamed{color:var(--dsw-alias-state-business-primary)}
.dshgc-path{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.dshgc-path-dir{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:55%}
.dshgc-path-name{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.dshgc-partial{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary);font-size:10px;white-space:nowrap}
.dshgc-touched{flex:none;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}
.dshgc-stat{flex:none;display:flex;gap:5px;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}
.dshgc-add-stat{color:var(--dsw-alias-state-success-primary)}
.dshgc-del-stat{color:var(--dsw-alias-state-error-primary)}
.dshgc-chevron{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-secondary);transition:transform .15s ease}
.dshgc-chevron-open{transform:rotate(90deg)}
.dshgc-chevron-spacer{flex:none;width:14px;height:14px}
.dshgc-preview{display:flex;flex-direction:column;flex:1 1 0;min-height:0;overflow:hidden}
.dshgc-preview-head{flex:none;display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dshgc-preview-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.dshgc-preview-stats{flex:none;display:flex;gap:6px;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.dshgc-preview-note{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshgc-preview-body{flex:1 1 0;min-height:0;overflow:auto;padding-bottom:12px}
.dshgc-preview-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;padding:24px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshgc-preview-error{color:var(--dsw-alias-state-error-primary)}
/* Content sets the width: a long line widens the table and the pane scrolls
   sideways, the way an IDE shows a diff. */
/* Two versions side by side. The box is fixed to the pane width, so each side
   scrolls on its own and the page never scrolls sideways. */
.dshgc-diff-box{display:flex;flex:1 1 0;min-height:0;min-width:0;width:100%;overflow:hidden}
.dshgc-pane{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.dshgc-pane-scroll{flex:1 1 0;min-height:0;overflow:auto}
.dshgc-marks{position:absolute;top:26px;bottom:8px;right:1px;width:9px;pointer-events:none;z-index:2}
.dshgc-mark{position:absolute;right:0;width:9px;height:3px;border-radius:2px;pointer-events:auto;cursor:pointer}
.dshgc-mark-add{background:var(--dsw-alias-brand-primary);opacity:.8}
.dshgc-mark-del{background:var(--dsw-alias-state-error-primary);opacity:.8}
.dshgc-mark:hover{opacity:1;height:4px}
.dshgc-pane-single{flex:1 1 0}
.dshgc-pane-head{position:relative;z-index:1;flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;overflow:hidden}
.dshgc-pane-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshgc-pane-ref{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.dshgc-pane-note{padding:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshgc-pane-head-grow{flex:1 1 auto;min-width:0}
.dshgc-pane-action{flex:none;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.dshgc-pane-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-pane-action:disabled{opacity:.5;cursor:default}
.dshgc-pane-action-primary{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
/* The working-tree side is one contenteditable body: a block per file line
   with the diff colours on the block, and a gutter column whose numbers are
   re-painted from the body after every structural edit. */
.dshgc-edit-wrap{display:flex;align-items:flex-start;min-width:max-content}
.dshgc-gutter{flex:none;width:56px;box-sizing:border-box}
.dshgc-gutter-cell{height:18px;line-height:18px;padding-right:8px;text-align:right;color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;user-select:none}
.dshgc-editbody{flex:1 1 auto;min-width:max-content;padding-bottom:12px;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre;outline:none;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-brand-primary)}
.dshgc-editline{min-height:18px;padding-right:12px}
.dshgc-editline-add{background:var(--dsw-alias-file-diff-added-bg)}
.dshgc-editline-void{background:var(--dsw-alias-bg-layer-1)}
.dshgc-editline-hunk{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dshgc-pane-body{min-width:max-content;padding-bottom:12px;font-family:var(--dsh-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.dshgc-line{display:flex;white-space:pre;line-height:18px}
.dshgc-line-no{flex:none;width:48px;text-align:right;padding-right:8px;color:var(--dsw-alias-label-tertiary);user-select:none}
.dshgc-line-code{padding-right:12px;white-space:pre}
.dshgc-line-ctx{color:var(--dsw-alias-label-primary)}
.dshgc-line-add{background:var(--dsw-alias-file-diff-added-bg);color:var(--dsw-alias-label-primary)}
.dshgc-line-del{background:var(--dsw-alias-file-diff-deleted-bg);color:var(--dsw-alias-label-primary)}
.dshgc-line-void{background:var(--dsw-alias-bg-layer-1)}
.dshgc-line-hunk{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dshgc-line-meta{color:var(--dsw-alias-label-tertiary)}
.dshgc-splitter{flex:none;width:6px;cursor:col-resize;background:var(--dsw-alias-border-l1);transition:background .12s ease}
.dshgc-splitter:hover{background:var(--dsw-alias-brand-primary)}
.dshgc-empty{display:flex;flex:1 1 auto;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;min-height:180px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dshgc-empty-mark{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dshgc-empty-title{color:var(--dsw-alias-label-primary);font-weight:600}
.dshgc-empty-body{max-width:340px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dshgc-retry{margin-top:8px;height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.dshgc-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshgc-loading{display:flex;flex:1 1 auto;align-items:center;justify-content:center;width:100%;height:100%;min-height:160px}
.dshgc-spinner{width:18px;height:18px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dshgc-spin .8s linear infinite}
@keyframes dshgc-spin{to{transform:rotate(360deg)}}
.dshgc-banner{margin:0 16px 8px;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.dshgc-banner-error{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-border-l2)}
.dshgc-commit{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 16px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dshgc-commit-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshgc-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshgc-check input{width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dshgc-commit-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshgc-textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:60px;max-height:180px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5}
.dshgc-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshgc-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshgc-commit-actions{display:flex;justify-content:flex-end}
.dshgc-primary{min-width:132px;height:30px;padding:0 14px;border:0;border-radius:7px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px;font-weight:500;cursor:pointer}
.dshgc-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshgc-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshgc-primary:disabled{opacity:.45;cursor:default}
.dshgc-notice-bar{padding:0 16px 8px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.dshgc-notice-ok{color:var(--dsw-alias-state-success-primary)}
.dshgc-notice-error{color:var(--dsw-alias-state-error-primary)}
.dshgc-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
/* The plugin's own configuration section on its 插件 page. The host wraps it in
   a bare flex section with no chrome of its own, so this brings all of it. */
.dshgc-card{display:flex;flex-direction:column;gap:10px;list-style:none;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshgc-card-head{display:flex;flex-direction:column;gap:2px}
.dshgc-card-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshgc-card-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshgc-card-field{display:flex;flex-direction:column;gap:6px}
.dshgc-card-labelrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshgc-card-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshgc-card-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshgc-card-notice{margin:0;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dshgc-card-reset{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:11px;cursor:pointer}
.dshgc-card-reset:hover:not(:disabled){text-decoration:underline}
.dshgc-card-reset:disabled{opacity:.5;cursor:default}
/* Segmented control: the two seats side by side, the chosen one raised. */
.dshgc-seg{display:inline-flex;align-self:flex-start;max-width:100%;padding:2px;gap:2px;border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
.dshgc-seg-btn{padding:5px 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;white-space:nowrap}
.dshgc-seg-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshgc-seg-btn:disabled{cursor:default;opacity:.6}
.dshgc-seg-btn-on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.12)}
`

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
