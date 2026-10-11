// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The browser modules together, as index.jsp loads them: map-history.js -> spatial-api.js -> spatial-dashboard.js
// -> spatial-compare.js, run in a vm sandbox with a minimal fake DOM (elements by id, textContent, attributes,
// events) and a fake Java API. map-analysis.js is replaced by a small window.gisAnalysis stub.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');
const OBSERVATION = require('./fixtures/compare-observation.json');
const CHANGE = require('./fixtures/compare-change.json');
const NOT_COMPARABLE = require('./fixtures/compare-not-comparable.json');
const PARTIAL_STATS = require('./fixtures/building-stats-partial.json');

class FakeElement {
	constructor(tagName, id) {
		this.tagName = tagName;
		this.id = id || null;
		this.hidden = false;
		this.disabled = false;
		this.checked = false;
		this.open = false;
		this.value = '';
		this.title = '';
		this.type = '';
		this.className = '';
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.ownText = '';
		const self = this;
		this.classList = {
			toggle(name, on) {
				const names = new Set(self.className.split(' ').filter(Boolean));
				if (on === undefined ? !names.has(name) : on) {
					names.add(name);
				} else {
					names.delete(name);
				}
				self.className = [...names].join(' ');
			},
			contains: (name) => self.className.split(' ').includes(name)
		};
	}

	get textContent() {
		return this.ownText + this.children.map((child) => child.textContent).join('');
	}

	set textContent(value) {
		this.ownText = String(value);
		this.children = [];
	}

	set innerHTML(value) {
		throw new Error('innerHTML must not be used: ' + value);
	}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	getAttribute(name) {
		return name in this.attributes ? this.attributes[name] : null;
	}

	addEventListener(type, listener) {
		(this.listeners[type] = this.listeners[type] || []).push(listener);
	}

	dispatch(type, event) {
		(this.listeners[type] || []).forEach((listener) => listener(event || { preventDefault() {} }));
	}

	click() {
		if (!this.disabled) {
			this.dispatch('click');
		}
	}

	focus() {}

	all(predicate) {
		const found = [];
		const walk = (node) => node.children.forEach((child) => {
			if (predicate(child)) {
				found.push(child);
			}
			walk(child);
		});
		walk(this);
		return found;
	}

	byClass(name) {
		return this.all((node) => node.className.split(' ').includes(name));
	}

	byAction(action) {
		return this.all((node) => node.getAttribute('data-action') === action);
	}
}

// Elements that index.jsp renders hidden.
const HIDDEN = ['history-section', 'spatial-section', 'history-compare', 'compare-selection', 'compare-status',
	'compare-retry', 'compare-result', 'compare-reasons', 'compare-warnings-title', 'compare-warnings',
	'spatial-view-compare', 'spatial-status', 'spatial-retry', 'spatial-result', 'spatial-warnings-title',
	'spatial-warnings', 'history-status', 'history-retry', 'history-empty', 'history-pager', 'analysis-save',
	'analysis-save-status', 'analysis-save-open-history'];

const PAGES = {
	1: [{ analysisId: 15, title: '이후 <b>분석</b>', radiusMeters: 100, buildingCount: 4, complete: false,
		analyzedAt: '2026-09-01T00:00:00Z', savedAt: '2026-09-01T00:01:00Z' },
	{ analysisId: 12, title: '이전 분석', radiusMeters: 100, buildingCount: 6, complete: true,
		analyzedAt: '2026-03-01T00:00:00Z', savedAt: '2026-03-01T00:01:00Z' }],
	2: [{ analysisId: 31, title: '다른 분석', radiusMeters: 500, buildingCount: 40, complete: true,
		analyzedAt: '2026-01-01T00:00:00Z', savedAt: '2026-01-01T00:01:00Z' }]
};

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
	for (let i = 0; i < 5; i++) {
		await flush();
	}
}

/**
 * routes(url, method) -> [status, body]. Defaults: Python available, two history pages, a comparison.
 * current: what window.gisAnalysis.getCurrent() returns.
 */
function page(options = {}) {
	const elements = {};
	const element = (id) => {
		if (!elements[id]) {
			elements[id] = new FakeElement('div', id);
			elements[id].hidden = HIDDEN.includes(id);
		}
		return elements[id];
	};
	const listeners = {};
	const requests = [];
	const tabs = [];
	const document = {
		currentScript: null,
		getElementById: element,
		createElement: (tag) => new FakeElement(tag),
		addEventListener: (type, listener) => {
			(listeners[type] = listeners[type] || []).push(listener);
		},
		dispatchEvent: (event) => {
			(listeners[event.type] || []).forEach((listener) => listener(event));
		}
	};
	const deleted = new Set();
	const route = options.route || (() => null);
	function respond(url, method) {
		const custom = route(url, method);
		if (custom) {
			return custom;
		}
		if (url.endsWith('/spatial-analysis/status')) {
			return [200, { available: true, configured: true }];
		}
		if (method === 'DELETE') {
			deleted.add(Number(url.split('/').pop()));
			return [204, null];
		}
		const list = url.match(/\/api\/analyses\?page=(\d+)/);
		if (list) {
			const items = (PAGES[list[1]] || []).filter((item) => !deleted.has(item.analysisId));
			return [200, { items, page: Number(list[1]), size: 10, totalItems: 3 - deleted.size, totalPages: 2,
				maxHistory: 500 }];
		}
		if (url.includes('/comparison')) {
			return [200, options.comparison || OBSERVATION];
		}
		if (url.includes('/statistics')) {
			return [200, PARTIAL_STATS];
		}
		return [404, { error: 'ANALYSIS_NOT_FOUND', message: 'x' }];
	}
	const window = {
		document,
		navigator: { onLine: true },
		CustomEvent,
		AbortController,
		Promise,
		console,
		fetch(url, init) {
			const method = (init && init.method) || 'GET';
			requests.push(method + ' ' + url);
			const [status, body] = respond(url, method);
			return Promise.resolve({ ok: status < 400, status, json: () => (body === null ? Promise.reject(new Error('empty'))
				: Promise.resolve(JSON.parse(JSON.stringify(body)))) });
		}
	};
	window.window = window;
	window.gisAnalysis = {
		getCurrent: () => options.current || null,
		showSaved: () => true,
		clearSaved: () => false,
		formatDateTime: (iso) => 'T(' + iso + ')',
		openInfoPanel(tab) {
			tabs.push(tab);
			document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab } }));
		}
	};
	// Attributes index.jsp puts on the view buttons.
	element('spatial-view-button-stats').setAttribute('data-view', 'stats');
	element('spatial-view-button-compare').setAttribute('data-view', 'compare');
	const context = vm.createContext(window);
	const load = (file, attributes) => {
		document.currentScript = { getAttribute: (name) => (attributes || {})[name] || null };
		vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
	};
	load('map-history.js', { 'data-api-url': '/api/analyses' });
	load('spatial-api.js');
	load('spatial-dashboard.js', { 'data-api-base': '/api' });
	load('spatial-compare.js', { 'data-api-base': '/api' });
	return {
		el: element,
		window,
		requests,
		tabs,
		emit(type, detail) {
			document.dispatchEvent(new CustomEvent(type, { detail }));
		},
		async openHistory() {
			element('history-section').hidden = false;
			document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab: 'history' } }));
			await settle();
		},
		item(id) {
			return element('history-list').children.find((li) => li.getAttribute('data-id') === String(id));
		},
		toggle(id) {
			this.item(id).byAction('compare')[0].click();
		},
		// Arrays made inside the vm context have another Array prototype: copy them for deepStrictEqual.
		selectedIds() {
			return [...this.window.gisCompare.getState().selection].map((s) => s.analysisId);
		}
	};
}

test('history items get a compare toggle; at most two are selected and marked', async () => {
	const p = page();
	await settle();
	await p.openHistory();

	const toggle = (id) => p.item(id).byAction('compare')[0];
	assert.equal(toggle(15).textContent, '비교 선택');
	assert.equal(toggle(15).getAttribute('aria-pressed'), 'false');
	assert.equal(p.el('history-compare').hidden, true);

	p.toggle(15);
	assert.match(p.item(15).className, /is-compare-selected/);
	assert.equal(toggle(15).textContent, '비교 해제');
	assert.equal(toggle(15).getAttribute('aria-pressed'), 'true');
	assert.equal(p.el('history-compare').hidden, false);
	assert.match(p.el('history-compare-text').textContent, /비교 선택 1\/2: 이후 <b>분석<\/b> · 한 건을 더 고르세요/);
	assert.equal(p.el('history-compare-run').disabled, true);

	p.toggle(12);
	assert.match(p.el('history-compare-text').textContent, /비교 선택 2\/2: 이후 <b>분석<\/b> ↔ 이전 분석/);
	assert.equal(p.el('history-compare-run').disabled, false);

	// Page 2: the selection is kept and a third analysis cannot be added.
	p.el('history-next').click();
	await settle();
	assert.equal(toggle(31).disabled, true);
	assert.match(toggle(31).title, /최대 2건/);
	assert.match(p.el('history-compare-text').textContent, /2\/2/);
	p.el('history-prev').click();
	await settle();
	assert.match(p.item(12).className, /is-compare-selected/);

	// Unselect one, then the other can be picked on page 2.
	p.toggle(15);
	p.el('history-next').click();
	await settle();
	assert.equal(toggle(31).disabled, false);
	p.toggle(31);
	assert.deepEqual(p.selectedIds(), [12, 31]);

	p.el('history-compare-clear').click();
	assert.equal(p.el('history-compare').hidden, true);
	assert.deepEqual(p.selectedIds(), []);
});

test('comparing opens the compare view and shows the result', async () => {
	const p = page({ current: { generation: 1, source: 'live', analysisToken: '0f8fad5b-d9cb-469f-a165-70867728950e',
		radius: 100 } });
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();

	assert.deepEqual(p.tabs, ['spatial']);
	assert.equal(p.el('spatial-view-compare').hidden, false);
	assert.equal(p.el('spatial-view-stats').hidden, true);
	assert.equal(p.el('spatial-view-button-compare').getAttribute('aria-pressed'), 'true');
	// The comparison is requested once; no statistics while the compare view is shown.
	assert.deepEqual(p.requests.filter((r) => r.includes('/comparison')),
		['GET /api/analyses/15/comparison?with=12&includeUnchanged=false&includeBuildingChanges=true']);
	assert.ok(!p.requests.some((r) => r.includes('/statistics')));

	assert.equal(p.el('spatial-view-compare').getAttribute('data-state'), 'done');
	assert.equal(p.el('compare-result').hidden, false);
	const sides = p.el('compare-pair').byClass('compare-side');
	assert.equal(sides[0].byClass('compare-side__label')[0].textContent, '이전 분석');
	assert.equal(sides[0].byClass('compare-side__title')[0].textContent, '이전 분석');
	assert.match(sides[0].byClass('compare-side__meta')[0].textContent, /^#12 · /);
	assert.equal(sides[1].byClass('compare-side__title')[0].textContent, '이후 <b>분석</b>');
	assert.match(sides[1].byClass('compare-side__meta')[0].textContent, /부분 조회$/);

	assert.match(p.el('compare-basis').className, /is-incomplete/);
	assert.match(p.el('compare-basis').textContent,
		/한쪽 이상의 분석이 부분 조회 결과입니다\. 실제 건물의 신축이나 철거로 단정할 수 없습니다\./);

	const metrics = p.el('compare-metrics').byClass('compare-metric');
	assert.equal(metrics.length, 6);
	const coverage = metrics.find((m) => m.getAttribute('data-metric') === 'coverageRatio');
	assert.equal(coverage.byClass('compare-metric__delta')[0].textContent, '-0.02%p');
	assert.match(coverage.byClass('compare-metric__delta')[0].className, /compare-delta--down/);

	const summary = p.el('compare-summary').byClass('compare-summary__label').map((n) => n.textContent);
	assert.deepEqual(summary.slice(0, 2), ['이후 분석에서만 관측', '이전 분석에서만 관측']);

	const lists = p.el('compare-lists').byClass('compare-list');
	assert.equal(lists.length, 3);
	assert.ok(lists.every((list) => list.open));
	const statuses = lists[0].byClass('compare-status').map((n) => n.textContent);
	assert.ok(statuses.includes('이후 분석에서만 관측') && statuses.includes('이전 분석에서만 관측'));
	assert.ok(!p.el('compare-result').textContent.match(/신축했|철거했|신축됨|철거됨/));
	const notes = p.el('compare-notes').children.map((n) => n.textContent);
	assert.match(notes[0], /VWorld 데이터 갱신 시점은 실제 건물의 신축·철거·증축 시점과 다를 수 있습니다/);

	// Back to the statistics view: now the statistics are requested.
	p.el('spatial-view-button-stats').click();
	await settle();
	assert.equal(p.requests.filter((r) => r.includes('/statistics')).length, 1);
});

test('the change list shows 50 rows first, then more', async () => {
	const p = page({ comparison: CHANGE });
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();

	const changes = p.el('compare-lists').byClass('compare-list')[0];
	assert.match(changes.byClass('compare-list__summary')[0].textContent, /건물별 변경 목록 \(58건\)/);
	assert.equal(changes.byClass('compare-item').length, 50);
	const more = changes.byClass('compare-list__more')[0];
	assert.equal(more.hidden, false);
	assert.equal(more.textContent, '더 보기 (8건 남음)');
	more.click();
	assert.equal(changes.byClass('compare-item').length, 58);
	assert.equal(more.hidden, true);
	assert.match(p.el('compare-basis').textContent, /실제 신축·철거를 확인한 것이 아닙니다/);
	const summary = p.el('compare-summary').byClass('compare-summary__label').map((n) => n.textContent);
	assert.deepEqual(summary.slice(0, 2), ['추가 (데이터 기준)', '삭제 (데이터 기준)']);
});

test('not comparable: reasons instead of statistics', async () => {
	const p = page({ comparison: NOT_COMPARABLE });
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();

	assert.equal(p.el('compare-result').hidden, false);
	assert.equal(p.el('compare-basis').byClass('analysis__completeness-title')[0].textContent, '비교할 수 없는 분석입니다');
	assert.equal(p.el('compare-reasons').hidden, false);
	assert.match(p.el('compare-reasons').textContent, /중심점이 다릅니다/);
	assert.match(p.el('compare-reasons').textContent, /반경이 다릅니다/);
	assert.equal(p.el('compare-metrics').children.length, 0);
	assert.equal(p.el('compare-lists').children.length, 0);
	assert.equal(p.el('compare-summary-title').hidden, true);
});

test('deleting a compared analysis removes it from the selection and the result', async () => {
	const p = page();
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();
	assert.equal(p.el('compare-result').hidden, false);

	p.item(15).byAction('delete')[0].click();
	p.item(15).byAction('confirm-delete')[0].click();
	await settle();

	assert.ok(p.requests.includes('DELETE /api/analyses/15'));
	assert.deepEqual(p.selectedIds(), [12]);
	assert.equal(p.el('compare-result').hidden, true);
	assert.match(p.el('compare-status').textContent, /삭제되어 비교 결과를 지웠습니다/);
	assert.match(p.el('history-compare-text').textContent, /1\/2/);
	assert.equal(p.item(15), undefined);
});

test('python unavailable: the comparison buttons are disabled with a notice', async () => {
	const p = page({ route: (url) => (url.endsWith('/spatial-analysis/status')
		? [200, { available: false, configured: true }] : null) });
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);

	assert.equal(p.el('history-compare-run').disabled, true);
	assert.equal(p.el('compare-run').disabled, true);
	assert.match(p.el('history-compare-text').textContent, /공간 분석 서버를 사용할 수 없어/);
	p.el('history-compare-run').click();
	await settle();
	assert.ok(!p.requests.some((r) => r.includes('/comparison')));
	// History, saving and the rest keep working: the list was loaded and is still shown.
	assert.ok(p.requests.some((r) => r.startsWith('GET /api/analyses?page=1')));
});

test('comparison errors stay in the compare view', async () => {
	const p = page({ route: (url) => (url.includes('/comparison')
		? [504, { error: 'ANALYSIS_SERVICE_TIMEOUT', message: 'internal' }] : null) });
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();

	assert.equal(p.el('spatial-view-compare').getAttribute('data-state'), 'error');
	assert.match(p.el('compare-status').textContent, /응답 시간이 초과/);
	assert.doesNotMatch(p.el('compare-status').textContent, /internal/);
	assert.equal(p.el('compare-retry').hidden, false);
	assert.equal(p.el('compare-result').hidden, true);
	// The statistics view and the history list are untouched.
	assert.equal(p.el('spatial-result').hidden, true);
	assert.equal(p.el('history-list').children.length, 2);
});

test('the include-unchanged option re-requests the comparison', async () => {
	const p = page();
	await settle();
	await p.openHistory();
	p.toggle(15);
	p.toggle(12);
	p.el('history-compare-run').click();
	await settle();
	p.el('compare-include-unchanged').checked = true;
	p.el('compare-include-unchanged').dispatch('change');
	await settle();

	assert.deepEqual(p.requests.filter((r) => r.includes('/comparison')).map((r) => r.includes('includeUnchanged=true')),
		[false, true]);
});

test('responsive rules for the compare view', () => {
	const css = fs.readFileSync(path.join(__dirname, '../../main/resources/static/css/main.css'), 'utf8');
	const block = css.slice(css.indexOf('/* ---------- 저장된 분석 비교 (8-6C)'), css.indexOf('/* ---------- 반응형 ---------- */'));

	assert.match(block, /\.compare-metrics \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
	assert.match(block, /@media \(max-width: 900px\) \{[^@]*\.history__compare-toggle,[^@]*min-height: 44px;/);
	assert.match(block, /@media \(max-width: 600px\) \{[^@]*\.compare-metric__delta \{\s*font-size: 14px;/);
	assert.doesNotMatch(block, /\.map-area|#map\b|\.map-container|--info-panel-width|--sidebar-width/);
});
