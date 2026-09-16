/**
 * Logic test for the panel-owned channel tools' caller guard (src: lib/index.js
 * callerOwnerId / callerGroup). The host resolves its own session's group; a member
 * (subagent) resolves its PARENT session's group — that is what lets any session with a
 * group directory do real group chat without composing the chat-group preset.
 *
 * Run: node test/caller-group.test.mjs
 */
import { callerOwnerId, callerGroup, groupDirFor } from '../lib/index.js'

const CWD = 'D:\\ws'
const HOST = 'session-host'
const MEMBER = 'session-member'
const STRANGER = 'session-stranger'

const execOf = (id, header) => ({ agent: { id, session: { header: Object.assign({ id, cwd: CWD }, header) } } })
const hostExec = execOf(HOST, { origin: undefined })
const memberExec = execOf(MEMBER, { origin: 'subagent', parentSession: HOST })
const strangerExec = execOf(STRANGER, { origin: undefined })

const rosterOf = (ownerId, members = []) => JSON.stringify({ owner: { id: ownerId, name: '主持人' }, members })

function fakeFs(files) {
	return {
		async resolve(path) { return { displayPath: path } },
		async readText(target) {
			const text = files[target.displayPath]
			if (text === undefined) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error }
			return text
		},
	}
}

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual)))
}

// The owner id is the caller's own session for a host and the parent session for a member.
check('host owns its own group', callerOwnerId(hostExec), HOST)
check('member belongs to its parent group', callerOwnerId(memberExec), HOST)
check('scopeless exec yields no owner', callerOwnerId({ agent: { id: MEMBER } }), undefined)

const groupFiles = {
	[groupDirFor(CWD, HOST) + '\\roster.json']: rosterOf(HOST, [{ id: MEMBER, name: 'SE', preset_id: 'se' }]),
}

// A session with a group directory resolves it, for host and member alike.
{
	const fs = fakeFs(groupFiles)
	const asHost = await callerGroup(fs, hostExec, '.agent-group')
	check('host resolves its group', [asHost.ownerId, asHost.dir, (asHost.roster.members || []).length], [HOST, groupDirFor(CWD, HOST), 1])
	const asMember = await callerGroup(fs, memberExec, '.agent-group')
	check('member resolves the SAME group (parent)', [asMember.ownerId, asMember.dir], [HOST, groupDirFor(CWD, HOST)])
}

// A session without a group gets an actionable error instead of a silent no-op.
{
	const fs = fakeFs({})
	const stranger = await callerGroup(fs, strangerExec, '.agent-group')
	check('session without a group is refused with a hint', [typeof stranger.error === 'string', stranger.error.includes('聊天群')], [true, true])
	check('refusal does not leak a directory', stranger.dir, undefined)
}

// No cwd → refused, never a throw.
{
	const fs = fakeFs(groupFiles)
	const broken = { agent: { id: HOST, session: { header: { id: HOST } } } }
	const got = await callerGroup(fs, broken, '.agent-group')
	check('missing cwd is refused', typeof got.error === 'string', true)
}

// Legacy single-group layout still answers, so old groups keep working.
{
	const legacy = { [CWD + '\\.agent-group\\roster.json']: rosterOf(HOST) }
	const got = await callerGroup(fakeFs(legacy), hostExec, '.agent-group')
	check('legacy layout resolves for its owner', [got.ownerId, got.dir], [HOST, CWD + '\\.agent-group'])
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
