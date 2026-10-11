// node --test src/test/js  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The browser part of spatial-dashboard.js (start) against a minimal fake DOM: the elements of index.jsp,
// textContent/hidden/attributes only. No jsdom or other package.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS = path.join(__dirname, '../../main/resources/static/js');
const api = require(path.join(JS, 'spatial-api.js'));
const dashboard = require(path.join(JS, 'spatial-dashboard.js'));
const PARTIAL = require('./fixtures/building-stats-partial.json');
const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

class FakeElement {
	constructor(tagName, id) {
		this.tagName = tagName;
		this.id = id || null;
		this.hidden = false;
		this.disabled = false;
		this.className = '';
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.ownText = '';
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

	click() {
		(this.listeners.click || []).forEach((listener) => listener({}));
	}

	find(className) {
		const found = [];
		const walk = (node) => {
			node.children.forEach((child) => {
				if (child.className.split(' ').includes(className)) {
					found.push(child);
				}
				walk(child);
			});
		};
		walk(this);
		return found;
	}
}

const IDS = ['spatial-section', 'spatial-service', 'spatial-service-badge', 'spatial-service-text',
	'spatial-service-recheck', 'spatial-empty', 'spatial-status', 'spatial-retry', 'spatial-result', 'spatial-source',
	'spatial-completeness', 'spatial-kpis', 'spatial-warnings-title', 'spatial-warnings'];

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** index.jsp elements, document events, a fake fetch answering by URL. */
function page(routes, current) {
	const elements = {};
	IDS.forEach((id) => {
		elements[id] = new FakeElement('div', id);
	});
	['spatial-section', 'spatial-status', 'spatial-retry', 'spatial-result', 'spatial-warnings-title',
		'spatial-warnings'].forEach((id) => {
		elements[id].hidden = true;
	});
	const listeners = {};
	const requests = [];
	const dispatched = [];
	const doc = {
		currentScript: { getAttribute: (name) => (name === 'data-api-base' ? '/ctx/api' : null) },
		getElementById: (id) => elements[id] || null,
		createElement: (tag) => new FakeElement(tag),
		addEventListener: (type, listener) => {
			(listeners[type] = listeners[type] || []).push(listener);
		},
		dispatchEvent: (event) => {
			dispatched.push(event);
			(listeners[event.type] || []).forEach((listener) => listener(event));
		}
	};
	const win = {
		gisSpatialApi: api,
		gisAnalysis: { getCurrent: () => current || null, formatDateTime: (iso) => 'T(' + iso + ')' },
		navigator: { onLine: true },
		CustomEvent
	};
	global.fetch = (url) => {
		requests.push(url);
		const route = Object.keys(routes).find((fragment) => url.includes(fragment));
		const [status, body] = route ? routes[route] : [404, { error: 'NOT_FOUND' }];
		return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
	};
	dashboard.start(doc, win);
	return {
		el: elements,
		win,
		requests,
		dispatched,
		emit(type, detail) {
			(listeners[type] || []).forEach((listener) => listener({ detail }));
		}
	};
}

const live = (generation) => ({ generation, source: 'live', analysisToken: TOKEN, radius: 100,
	snapshotExpiresAt: '2026-10-11T03:30:00Z' });

test('status is checked once on page load and shown as a badge', async () => {
	const p = page({ '/spatial-analysis/status': [200, { available: true, configured: true }] });
	await flush();

	assert.deepEqual(p.requests, ['/ctx/api/spatial-analysis/status']);
	assert.equal(p.el['spatial-service'].getAttribute('data-state'), 'available');
	assert.equal(p.el['spatial-service-badge'].textContent, '사용 가능');
	assert.equal(p.el['spatial-service-recheck'].disabled, false);
	assert.equal(p.el['spatial-empty'].hidden, false);
	assert.equal(typeof p.win.gisSpatialDashboard.getState, 'function');
});

for (const [body, state, label] of [[{ available: false, configured: true }, 'unavailable', '사용 불가'],
	[{ available: false, configured: false }, 'not-configured', '설정되지 않음']]) {
	test('python ' + state + ': badge, guidance and no statistics request', async () => {
		const p = page({ '/spatial-analysis/status': [200, body] }, live(1));
		await flush();
		p.emit('gis:tabchange', { tab: 'spatial' });
		await flush();

		assert.equal(p.el['spatial-service-badge'].textContent, label);
		assert.match(p.el['spatial-service-text'].textContent, /반경 분석/);
		assert.equal(p.el['spatial-section'].getAttribute('data-state'), 'blocked');
		assert.match(p.el['spatial-status'].textContent, /다시 확인/);
		assert.ok(!p.requests.some((url) => url.includes('/statistics')));
	});
}

test('opening the tab shows the KPI cards, completeness box and warnings', async () => {
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/statistics': [200, PARTIAL]
	}, live(1));
	await flush();
	assert.ok(!p.requests.some((url) => url.includes('/statistics')));  // hidden tab: nothing requested

	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();

	assert.ok(p.requests.includes('/ctx/api/analysis-snapshots/' + TOKEN + '/statistics'));
	assert.equal(p.el['spatial-section'].getAttribute('data-state'), 'done');
	assert.equal(p.el['spatial-result'].hidden, false);
	assert.equal(p.el['spatial-empty'].hidden, true);
	assert.equal(p.el['spatial-status'].hidden, true);
	assert.equal(p.el['spatial-source'].textContent,
		'저장 전 분석 · 반경 100m · T(2026-10-11T03:30:00Z)까지 조회 가능');

	const cards = p.el['spatial-kpis'].find('spatial-kpi');
	assert.equal(cards.length, 8);
	const card = (key) => cards.find((c) => c.getAttribute('data-kpi') === key);
	assert.equal(card('coverage').find('spatial-kpi__value')[0].textContent, '2.54%');
	assert.equal(card('area').find('spatial-kpi__value')[0].textContent, '796.6 m²');
	assert.equal(card('averageFloors').find('spatial-kpi__value')[0].textContent, '4.0층');
	assert.equal(card('excluded').find('spatial-kpi__value')[0].textContent, '1개');

	const completeness = p.el['spatial-completeness'];
	assert.match(completeness.className, /is-incomplete/);
	assert.match(completeness.textContent, /관측된 건물만 집계한 결과/);
	assert.match(completeness.textContent, /조회 한도/);
	assert.equal(p.el['spatial-warnings'].hidden, false);
	assert.equal(p.el['spatial-warnings'].children.length, 4);
	assert.match(p.el['spatial-warnings'].textContent, /\(1건\)/);
});

test('server strings are inserted as text only', async () => {
	const hostile = JSON.parse(JSON.stringify(PARTIAL));
	hostile.result.warnings = [{ code: 'X', message: '<img src=x onerror=alert(1)>', count: 1 }];
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/statistics': [200, hostile]
	}, { generation: 1, source: 'saved', analysisId: 12, title: '<b>제목</b>', radius: 100 });
	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();

	assert.equal(p.el['spatial-warnings'].children[0].textContent, '<img src=x onerror=alert(1)> (1건)');
	assert.equal(p.el['spatial-source'].textContent, '저장된 분석 #12 · <b>제목</b>');
});

test('errors are shown without touching anything else, retryable ones with a retry button', async () => {
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/statistics': [503, { error: 'ANALYSIS_SERVICE_BUSY', message: 'internal detail' }]
	}, live(1));
	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();

	assert.equal(p.el['spatial-section'].getAttribute('data-state'), 'error');
	assert.equal(p.el['spatial-status'].textContent, api.MESSAGES.ANALYSIS_SERVICE_BUSY);
	assert.match(p.el['spatial-status'].className, /is-error/);
	assert.equal(p.el['spatial-retry'].hidden, false);
	assert.equal(p.el['spatial-result'].hidden, true);
	assert.doesNotMatch(p.el['spatial-status'].textContent, /internal detail/);
});

test('an expired snapshot has no retry button', async () => {
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/statistics': [410, { error: 'SNAPSHOT_EXPIRED', message: 'x' }]
	}, live(1));
	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();

	assert.equal(p.el['spatial-status'].textContent, api.MESSAGES.SNAPSHOT_EXPIRED);
	assert.equal(p.el['spatial-retry'].hidden, true);
});

test('saving switches the next request to the analysis id', async () => {
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/analyses/21/statistics': [200, PARTIAL],
		'/analysis-snapshots/': [410, { error: 'SNAPSHOT_EXPIRED', message: 'x' }]
	}, live(4));
	await flush();
	p.emit('gis:analysissaved', { generation: 4, analysisId: 21, title: '저장 제목' });
	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();

	assert.ok(p.requests.includes('/ctx/api/analyses/21/statistics'));
	assert.ok(!p.requests.some((url) => url.includes('/analysis-snapshots/')));
	assert.equal(p.el['spatial-section'].getAttribute('data-state'), 'done');
	assert.equal(p.el['spatial-source'].textContent, '저장된 분석 #21 · 저장 제목');
});

test('reset empties the dashboard', async () => {
	const p = page({
		'/spatial-analysis/status': [200, { available: true, configured: true }],
		'/statistics': [200, PARTIAL]
	}, live(1));
	p.emit('gis:tabchange', { tab: 'spatial' });
	await flush();
	p.emit('gis:analysisresult', { generation: 2, source: null });

	assert.equal(p.el['spatial-section'].getAttribute('data-state'), 'empty');
	assert.equal(p.el['spatial-empty'].hidden, false);
	assert.equal(p.el['spatial-result'].hidden, true);
});

test('recheck button asks for the status again', async () => {
	const p = page({ '/spatial-analysis/status': [200, { available: false, configured: true }] });
	await flush();
	p.el['spatial-service-recheck'].click();

	assert.equal(p.el['spatial-service-badge'].textContent, '확인 중');
	assert.equal(p.el['spatial-service-recheck'].disabled, true);
	await flush();
	assert.equal(p.requests.filter((url) => url.endsWith('/spatial-analysis/status')).length, 2);
	assert.equal(p.el['spatial-service-badge'].textContent, '사용 불가');
});

test('responsive rules: two KPI columns, touch sizes at 900px, smaller values at 600px', () => {
	const css = fs.readFileSync(path.join(__dirname, '../../main/resources/static/css/main.css'), 'utf8');
	const block = css.slice(css.indexOf('/* ---------- 공간 분석 탭'), css.indexOf('/* ---------- 반응형 ---------- */'));

	assert.match(block, /\.spatial-kpis \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
	assert.match(block, /@media \(max-width: 900px\) \{[^@]*\.spatial-views__button,[^@]*min-height: 44px;/);
	assert.match(block, /@media \(max-width: 600px\) \{[^@]*\.spatial-kpi__value \{\s*font-size: 15px;/);
	assert.match(block, /\.info-tabs__tab \{\s*min-width: 0;\s*padding: 0 4px;\s*white-space: nowrap;/);
	// The map area itself is not restyled by this block.
	assert.doesNotMatch(block, /\.map-area|#map\b|\.map-container|--info-panel-width|--sidebar-width/);
});
