// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// main.css: button rows of the analysis history items and the hotspot view (8-7-6 text overflow fix).
// Node has no layout engine: these are static checks of the rules; the real widths are checked in the browser.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '../../main/resources/static/css/main.css'), 'utf8');
const HISTORY_JS = fs.readFileSync(path.join(__dirname, '../../main/resources/static/js/map-history.js'), 'utf8');

/** Top-level and @media blocks: [{ media, selectors: [..], body, at }] in source order (comments removed). */
function rules(css) {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
	const found = [];
	function walk(text, offset, media) {
		let i = 0;
		while (i < text.length) {
			const open = text.indexOf('{', i);
			if (open < 0) {
				break;
			}
			const head = text.slice(i, open).trim();
			let depth = 1;
			let j = open + 1;
			for (; j < text.length && depth > 0; j++) {
				depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
			}
			const body = text.slice(open + 1, j - 1);
			if (head.startsWith('@media')) {
				walk(body, offset + open + 1, head);
			} else {
				found.push({ media, selectors: head.split(',').map((s) => s.trim()), body, at: offset + open });
			}
			i = j;
		}
	}
	walk(source, 0, null);
	return found;
}

const ALL = rules(CSS);

function rule(selector, media = null) {
	const list = ALL.filter((r) => r.media === media && r.selectors.includes(selector));
	assert.ok(list.length > 0, 'no rule for ' + selector + (media ? ' in ' + media : ''));
	return list;
}

function declarations(selector, media = null) {
	const result = {};
	rule(selector, media).forEach((r) => r.body.split(';').forEach((d) => {
		const k = d.indexOf(':');
		if (k > 0) {
			result[d.slice(0, k).trim()] = d.slice(k + 1).trim();
		}
	}));
	return result;
}

/* ---------- analysis history ---------- */

test('history buttons: no fixed height, the text height fits, the row wraps instead of overflowing', () => {
	const row = declarations('.history__actions');
	assert.equal(row.display, 'flex');
	assert.equal(row['flex-wrap'], 'wrap');
	assert.equal(row['min-width'], '0');

	const button = declarations('.history__actions .tool-bar__button');
	assert.equal(button.height, 'auto', 'overrides .tool-bar__button { height: 28px }');
	assert.equal(button['min-height'], '28px');
	assert.equal(button['line-height'], '1.4');
	assert.match(button.padding, /^4px 10px$/);
	assert.equal(button['margin-left'], '0', 'no auto margin from the primary style');
	assert.equal(button['min-width'], '0');
	assert.equal(button['white-space'], 'normal', 'in the worst case the text wraps inside the growing button');
	assert.equal(button['overflow-wrap'], 'anywhere');
	assert.equal(button.flex, '1 1 7em', 'same basis: the buttons of one row share it evenly');
	// The base button keeps its height for every other toolbar.
	assert.equal(declarations('.tool-bar__button').height, '28px');
	// The history rule comes after the base rule, so it wins at equal specificity.
	assert.ok(rule('.history__actions .tool-bar__button')[0].at > rule('.tool-bar__button')[0].at);
});

test('"지도에서 보기" takes the whole first line; delete and compare share the next one', () => {
	assert.equal(declarations('.history__actions .tool-bar__button[data-action="open"]')['flex-basis'], '100%');
	// The selector matches what map-history.js renders, in this order.
	const order = ["'data-action', 'open'", "'data-action', 'delete'", "'data-action', 'compare'"]
		.map((s) => HISTORY_JS.indexOf(s));
	assert.ok(order.every((i) => i > 0));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.match(HISTORY_JS, /'지도에서 보기'/);
	assert.match(HISTORY_JS, /'불러오는 중\.\.\.'/);
	// Delete confirmation: the question takes a full line, then delete and cancel side by side.
	assert.ok(HISTORY_JS.includes("'data-action', 'confirm-delete'") && HISTORY_JS.includes("'data-action', 'cancel-delete'"));
	assert.equal(declarations('.history__confirm').flex, '1 1 100%');
});

test('history buttons keep the 44 px touch target at 900 px and below', () => {
	const tablet = ALL.filter((r) => r.media === '@media (max-width: 900px)'
		&& r.selectors.includes('.history__actions .tool-bar__button'));
	assert.ok(tablet.length > 0);
	assert.ok(tablet.some((r) => /min-height:\s*44px/.test(r.body)));
	assert.ok(tablet.every((r) => r.at > rule('.history__actions .tool-bar__button')[0].at), 'the media rule comes later');
	assert.ok(ALL.some((r) => r.media === '@media (max-width: 900px)' && r.selectors.includes('.history__compare-toggle')
		&& /min-height:\s*44px/.test(r.body)));
});

/* ---------- hotspot view ---------- */

test('hotspot run and clear buttons: no fixed height, padding and min-height, wrap instead of overlapping', () => {
	const row = declarations('.hotspot-actions');
	assert.equal(row.display, 'flex');
	assert.equal(row['flex-wrap'], 'wrap');
	assert.equal(row['min-width'], '0');
	const button = declarations('.hotspot-actions .tool-bar__button');
	assert.equal(button.height, 'auto');
	assert.equal(button['min-height'], '28px');
	assert.match(button.padding, /^4px 10px$/);
	assert.equal(button['line-height'], '1.4');
	assert.equal(button['margin-left'], '0');
	assert.equal(button['min-width'], '0');
	assert.equal(button['white-space'], 'normal');
	assert.equal(button['overflow-wrap'], 'anywhere');
	assert.equal(button.flex, '1 1 auto');
	assert.ok(rule('.hotspot-actions .tool-bar__button')[0].at > rule('.tool-bar__button')[0].at);
});

test('hotspot buttons: 44 px at 900 px and below, stacked at 600 px and below', () => {
	assert.ok(ALL.some((r) => r.media === '@media (max-width: 900px)'
		&& r.selectors.includes('.hotspot-actions .tool-bar__button') && /min-height:\s*44px/.test(r.body)));
	assert.ok(ALL.some((r) => r.media === '@media (max-width: 600px)' && r.selectors.includes('.hotspot-actions')
		&& /flex-direction:\s*column/.test(r.body)));
});
