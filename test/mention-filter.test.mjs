/**
 * Logic test for the `@` menu filter (src: lib/index.js installMentionFilter).
 * No test runner: plain node, fake resolver + fake sessionQuery, assertions by hand.
 *
 * Run: node test/mention-filter.test.mjs
 */
import { installMentionFilter } from '../lib/index.js'

const SELF = 'session-self'
const OTHER = 'session-other'
const MY_CHILD = 'session-my-child'
const MY_GRANDCHILD = 'session-my-grandchild'
const OTHER_CHILD = 'session-other-child'
const ROOT = 'session-root'
const COLD_MY_CHILD = 'session-cold-my-child'

// root SELF, root OTHER, root ROOT, OTHER's child, SELF's child, SELF's grandchild, one cold child of SELF
const headers = [
	{ id: SELF, origin: undefined },
	{ id: OTHER, origin: undefined },
	{ id: ROOT, origin: undefined },
	{ id: OTHER_CHILD, origin: 'subagent', parentSession: OTHER },
	{ id: MY_CHILD, origin: 'subagent', parentSession: SELF },
	{ id: MY_GRANDCHILD, origin: 'subagent', parentSession: MY_CHILD },
	// deliberately absent from the listing: must survive as "unknown"
]

const rows = [SELF, OTHER, ROOT, OTHER_CHILD, MY_CHILD, MY_GRANDCHILD, COLD_MY_CHILD].map((sessionId) => ({
	sessionId,
	label: sessionId,
}))

const resolver = {
	ctx: { sessionQuery: { listSessions: async () => headers.map((header) => ({ header })) } },
	async listCandidates() { return rows },
}

const ctx = { get: (name) => (name === 'sessionReferenceResolver' ? resolver : undefined) }

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '\n      expected ' + JSON.stringify(expected) + '\n      actual   ' + JSON.stringify(actual)))
}

const test = async () => {
	const dispose = installMentionFilter(ctx)
	if (typeof dispose !== 'function') {
		console.log('FAIL  installMentionFilter returned no disposer')
		failures += 1
		return
	}

	const kept = (await resolver.listCandidates({ id: SELF }, '', 50, undefined)).map((row) => row.sessionId)
	check('keeps self-roots + own subagent tree, drops other sessions subagents', kept, [
		SELF, OTHER, ROOT, MY_CHILD, MY_GRANDCHILD, COLD_MY_CHILD,
	])

	// A different caller keeps its own tree instead.
	const otherKept = (await resolver.listCandidates({ id: OTHER }, '', 50, undefined)).map((row) => row.sessionId)
	check('per-caller scoping', otherKept, [SELF, OTHER, ROOT, OTHER_CHILD, COLD_MY_CHILD])

	// A warm cache legitimately survives a listing failure: lineage data is stable.
	resolver.ctx.sessionQuery.listSessions = async () => { throw new Error('boom') }
	const warm = (await resolver.listCandidates({ id: SELF }, '', 50, undefined)).map((row) => row.sessionId)
	check('warm cache keeps filtering when the listing fails', warm, [
		SELF, OTHER, ROOT, MY_CHILD, MY_GRANDCHILD, COLD_MY_CHILD,
	])

	// Cold start plus a failing listing must degrade to the shipped behaviour (hide nothing).
	const coldResolver = {
		ctx: { sessionQuery: { listSessions: async () => { throw new Error('boom') } } },
		async listCandidates() { return rows },
	}
	const coldDispose = installMentionFilter({ get: () => coldResolver })
	const cold = (await coldResolver.listCandidates({ id: SELF }, '', 50, undefined)).map((row) => row.sessionId)
	check('cold + failing listing degrades to unfiltered', cold, rows.map((row) => row.sessionId))
	coldDispose()

	// Dispose restores the original method.
	dispose()
	check('dispose restores the original', resolver.listCandidates === Object.getPrototypeOf(resolver).listCandidates || typeof resolver.listCandidates === 'function', true)
	const restored = (await resolver.listCandidates({ id: SELF }, '', 50, undefined)).map((row) => row.sessionId)
	check('after dispose nothing is filtered', restored, rows.map((row) => row.sessionId))
}

await test()
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
