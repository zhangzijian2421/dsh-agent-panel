/**
 * Codec test: the client-side mention encoder must be byte-compatible with the shipped
 * session-reference codec, or a picked agent degrades to inert text.
 *
 * Run: node test/mention-codec.test.mjs
 */
import { encodeSessionReferenceUri, parseSessionReferenceText } from 'file:///C:/Users/zijian/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/types/uri.js'

/** The exact algorithm from lib/client.js encodeSessionMention (browser globals). */
function encodeSessionMention(sessionId, label) {
	const bytes = new TextEncoder().encode(JSON.stringify(String(sessionId)))
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	const escaped = String(label).replace(/[\\\]]/g, (match) => '\\' + match)
	return '@[' + escaped + '](dsh-session:' + payload + ')'
}

let failures = 0
const check = (label, actual, expected) => {
	const ok = actual === expected
	if (!ok) failures += 1
	console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '\n      expected ' + expected + '\n      actual   ' + actual))
}

const ids = [
	'session-3d86f452-20ef-4353-b962-55b598a8e479',
	'5531ca1f-3dd2-4839-9682-bc94f96247c8',
	'a',
]
const labels = ['极简模式', 'SE 需求分析', 'devdept', 'with ] bracket', 'with \\ backslash', 'a]\\b', 'emoji 👥 ok']

for (const id of ids) {
	for (const label of labels) {
		const mine = encodeSessionMention(id, label)
		// 1. The payload must equal the shipped encoder's canonical URI.
		const uri = encodeSessionReferenceUri(id)
		check('uri payload matches shipped encoder: ' + id.slice(0, 12) + ' / ' + label, mine.slice(mine.indexOf('(') + 1, -1), uri)
		// 2. The shipped parser must accept it and recover id + readable label.
		let parsed
		try {
			parsed = parseSessionReferenceText(mine)
		} catch (error) {
			failures += 1
			console.log('FAIL  shipped parser rejected the mention for ' + label + ': ' + error.message)
			continue
		}
		check('parser recovers session id: ' + label, parsed.references.length === 1 ? parsed.references[0].sessionId : 'none', id)
		check('parser renders readable text: ' + label, parsed.text, '@' + label)
	}
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
