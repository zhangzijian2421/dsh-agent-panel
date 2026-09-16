/**
 * Logic test for multi-group directory resolution (src: lib/index.js resolveGroupDir).
 * A workspace hosts any number of independent groups, one directory per owning session,
 * with the legacy single-group layout still honoured for its recorded owner.
 *
 * Run: node test/group-dir.test.mjs
 */
import { resolveGroupDir, groupDirFor } from '../lib/index.js'

const CWD = 'D:\\ws'
const OWNER = 'session-aaa'
const OTHER = 'session-bbb'

/** Minimal fs-service fake: resolve() returns the path, readText() reads from a map. */
function fakeFs(files) {
	return {
		async resolve(path) { return { displayPath: path } },
		async readText(target) {
			const text = files[target.displayPath]
			if (text === undefined) {
				const error = new Error('ENOENT')
				error.code = 'ENOENT'
				throw error
			}
			return text
		},
	}
}

const rosterOf = (ownerId, members = []) => JSON.stringify({ owner: { id: ownerId, name: '主持人' }, members })

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual)))
}

const modernDir = groupDirFor(CWD, OWNER)
const legacyRosterPath = CWD + '\\.agent-group\\roster.json'

// 1. Modern layout wins.
{
	const fs = fakeFs({ [modernDir + '\\roster.json']: rosterOf(OWNER, [{ id: 'c1' }]) })
	const got = await resolveGroupDir(fs, CWD, OWNER)
	check('modern dir used when present', [got.dir, got.legacy, (got.roster.members || []).length], [modernDir, false, 1])
}

// 2. Legacy layout honoured only for its recorded owner.
{
	const fs = fakeFs({ [legacyRosterPath]: rosterOf(OWNER, [{ id: 'c1' }, { id: 'c2' }]) })
	const mine = await resolveGroupDir(fs, CWD, OWNER)
	check('legacy dir used by its owner', [mine.dir, mine.legacy, mine.roster.members.length], [CWD + '\\.agent-group', true, 2])
	const theirs = await resolveGroupDir(fs, CWD, OTHER)
	check('legacy dir NOT claimed by another session', [theirs.dir, theirs.legacy, theirs.roster], [groupDirFor(CWD, OTHER), false, undefined])
}

// 3. Nothing exists: the modern path is returned as the creation target.
{
	const got = await resolveGroupDir(fakeFs({}), CWD, OWNER)
	check('absent group resolves to its own creation dir', [got.dir, got.roster, got.legacy], [modernDir, undefined, false])
}

// 4. Two owners in one workspace resolve to two different directories.
{
	const fs = fakeFs({
		[groupDirFor(CWD, OWNER) + '\\roster.json']: rosterOf(OWNER),
		[groupDirFor(CWD, OTHER) + '\\roster.json']: rosterOf(OTHER),
	})
	const a = await resolveGroupDir(fs, CWD, OWNER)
	const b = await resolveGroupDir(fs, CWD, OTHER)
	check('two groups in one workspace stay independent', a.dir !== b.dir, true)
}

// 5. A missing fs never throws (resolving must not fail a pull).
{
	const got = await resolveGroupDir(undefined, CWD, OWNER)
	check('undefined fs degrades to the modern path', [got.dir, got.roster], [modernDir, undefined])
}

// 6. A corrupt roster counts as absent, not as an error.
{
	const fs = fakeFs({ [modernDir + '\\roster.json']: '{ this is not json' })
	const got = await resolveGroupDir(fs, CWD, OWNER)
	check('corrupt roster is treated as absent-but-present-dir', [got.dir, got.legacy, Array.isArray(got.roster.members)], [modernDir, false, true])
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
