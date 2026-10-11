// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The grid view in the page: spatial-api.js -> spatial-dashboard.js -> spatial-compare.js -> spatial-grid-renderer.js
// -> spatial-grid.js, as index.jsp loads them, in a vm sandbox with a minimal fake DOM, a fake VWorld map and a fake
// Java API. map-analysis.js is replaced by a stub. Real VWorld rendering is checked in the browser (8-6B-2d).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');
const GRID = require('./fixtures/grid-density-100m-50.json');
const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

class FakeElement {
	constructor(tagName, id) {
		this.tagName = tagName;
		this.id = id || null;
		this.hidden = false;
		this.disabled = false;
		this.checked = false;
		this.className = '';
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.ownText = '';
		this.style = {};
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

	dispatch(type) {
		(this.listeners[type] || []).forEach((listener) => listener({}));
	}

	click() {
		if (!this.disabled) {
			this.dispatch('click');
		}
	}

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
}

const HIDDEN = ['spatial-section', 'spatial-view-grid', 'spatial-view-compare', 'grid-status', 'grid-retry',
	'grid-summary', 'grid-notices', 'grid-detail', 'spatial-status', 'spatial-retry', 'spatial-result',
	'spatial-warnings-title', 'spatial-warnings', 'history-compare', 'compare-selection', 'compare-status',
	'compare-retry', 'compare-result', 'compare-reasons', 'compare-warnings-title', 'compare-warnings'];

function settle() {
	return new Promise((resolve) => setTimeout(resolve, 30));
}

function gridFor(size, change) {
	const body = JSON.parse(JSON.stringify(GRID));
	body.result.cellSizeMeters = size;
	if (change) {
		change(body.result);
	}
	return body;
}

function page(options = {}) {
	const elements = {};
	const element = (id) => {
		if (!elements[id]) {
			elements[id] = new FakeElement('div', id);
			elements[id].hidden = HIDDEN.includes(id);
		}
		return elements[id];
	};
	[['spatial-view-button-stats', 'data-view', 'stats'], ['spatial-view-button-grid', 'data-view', 'grid'],
		['spatial-view-button-compare', 'data-view', 'compare'], ['grid-size-50', 'data-cell-size', '50'],
		['grid-size-100', 'data-cell-size', '100'], ['grid-size-200', 'data-cell-size', '200']]
		.forEach(([id, name, value]) => element(id).setAttribute(name, value));
	element('grid-exclude-empty').checked = true;
	const listeners = {};
	const requests = [];
	const document = {
		currentScript: null,
		getElementById: element,
		createElement: (tag) => new FakeElement(tag),
		addEventListener: (type, fn) => {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event))
	};
	// fake VWorld map
	const created = [];
	const removed = [];
	class PolygonZ {
		constructor(c) {
			this.points = c.items;
		}

		setFillColor() {}

		create() {
			created.push(this);
		}

		addEventListener(fn) {
			this.listener = fn;
		}

		removeEventListener() {
			this.listener = null;
		}
	}
	let clearCalls = 0;
	const map = { removeObject: (o) => removed.push(o), clear: () => clearCalls++ };
	const calls = { suppress: 0, buildings: [], tabs: [] };
	const route = options.route || (() => null);
	const window = {
		document,
		console,
		CustomEvent,
		AbortController,
		Promise,
		navigator: { onLine: true },
		requestAnimationFrame: (cb) => setImmediate(() => cb(0)),
		cancelAnimationFrame: (id) => clearImmediate(id),
		vw: { geom: { PolygonZ }, Collection: class { constructor(i) { this.items = i; } },
			Coord: class { constructor(x, y) { this.v = [x, y]; } }, Color: class {} },
		gisMap: map,
		gisTools: { getMode: () => options.mode || 'select' },
		gisAnalysis: {
			getCurrent: () => (options.noAnalysis ? null
				: { generation: 1, source: 'live', analysisToken: TOKEN, radius: 100 }),
			suppressNextMapClick: () => calls.suppress++,
			formatDateTime: (iso) => iso,
			openInfoPanel: (tab) => {
				calls.tabs.push(tab);
				document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab } }));
			}
		},
		gisAnalysisRenderer: { setBuildingsVisible: (v) => calls.buildings.push(v) },
		fetch(url) {
			requests.push(url);
			const custom = route(url);
			const [status, body] = custom || (url.endsWith('/spatial-analysis/status')
				? [200, { available: true, configured: true }]
				: url.includes('/grid-density') ? [200, gridFor(Number(url.match(/cellSize=(\d+)/)[1]))]
					: [404, { error: 'ANALYSIS_NOT_FOUND' }]);
			return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
		}
	};
	window.window = window;
	const context = vm.createContext(window);
	const load = (file, base) => {
		document.currentScript = { getAttribute: (name) => (name === 'data-api-base' && base ? '/api' : null) };
		vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
	};
	load('spatial-api.js');
	load('spatial-dashboard.js', true);
	load('spatial-compare.js', true);
	load('spatial-grid-renderer.js');
	load('spatial-grid.js', true);
	const onMap = () => created.filter((o) => !removed.includes(o));
	return {
		el: element, window, requests, created, removed, calls, onMap,
		clearCalls: () => clearCalls,
		emit: (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail })),
		gridRequests: () => requests.filter((r) => r.includes('/grid-density')),
		async toggleDisplay(on) {
			element('grid-display').checked = on;
			element('grid-display').dispatch('change');
			await settle();
		}
	};
}

test('the grid view is enabled and switching to it requests nothing by itself', async () => {
	const p = page();
	await settle();
	p.el('spatial-view-button-grid').click();  // the grid view first, then the tab opens on it
	p.el('spatial-section').hidden = false;
	p.emit('gis:tabchange', { tab: 'spatial' });
	await settle();

	assert.equal(p.el('spatial-view-grid').hidden, false);
	assert.equal(p.el('spatial-view-stats').hidden, true);
	assert.equal(p.el('spatial-view-button-grid').getAttribute('aria-pressed'), 'true');
	assert.equal(p.gridRequests().length, 0);
	assert.ok(!p.requests.some((r) => r.includes('/statistics')));  // statistics only in the statistics view
	assert.equal(p.el('grid-display').checked, false);
	assert.equal(p.el('grid-display').disabled, false);
	assert.equal(p.el('grid-empty').hidden, true);
	const legend = p.el('grid-legend').children;
	assert.equal(legend.length, 7);
	assert.match(legend[0].textContent, /0~5%/);
	assert.match(legend[0].children[0].style.backgroundColor, /^rgba\(255, 237, 160, 0\.59\)$/);
	assert.equal(p.el('grid-size-100').getAttribute('aria-pressed'), 'true');
});

test('display on: 100 m request, cells on the map, buildings hidden, summary shown', async () => {
	const p = page();
	await settle();
	await p.toggleDisplay(true);

	assert.deepEqual(p.gridRequests(),
		['/api/analysis-snapshots/' + TOKEN + '/grid-density?cellSize=100&includeEmptyCells=true&includeBuildingIds=false']);
	assert.equal(p.onMap().length, 8);
	assert.deepEqual(p.calls.buildings, [false]);
	assert.equal(p.el('grid-display').checked, true);
	assert.equal(p.el('grid-summary').hidden, false);
	assert.equal(p.el('grid-summary').textContent, '셀 100m · 표시 8개 / 전체 21개 · 빈 격자 13개 숨김');
	assert.equal(p.el('grid-status').hidden, true);
	assert.equal(p.el('spatial-view-grid').getAttribute('data-state'), 'done');
});

test('cell size buttons, empty-cell toggle and display off', async () => {
	const p = page();
	await settle();
	await p.toggleDisplay(true);
	p.el('grid-size-50').click();
	await settle();
	assert.match(p.gridRequests()[1], /cellSize=50/);
	assert.equal(p.el('grid-size-50').getAttribute('aria-pressed'), 'true');
	assert.equal(p.onMap().length, 8);

	p.el('grid-exclude-empty').checked = false;
	p.el('grid-exclude-empty').dispatch('change');
	await settle();
	assert.equal(p.onMap().length, 21);
	assert.equal(p.gridRequests().length, 2);

	await p.toggleDisplay(false);
	assert.equal(p.onMap().length, 0);
	assert.deepEqual(p.calls.buildings, [false, true]);
	assert.equal(p.el('grid-summary').hidden, true);
	assert.equal(p.clearCalls(), 0);
});

test('the grid stays on the map when another spatial view is shown', async () => {
	const p = page();
	await settle();
	await p.toggleDisplay(true);
	p.el('spatial-view-button-compare').click();
	p.el('spatial-view-button-stats').click();
	await settle();
	assert.equal(p.onMap().length, 8);
});

test('cell click: no new radius center, cell details in the grid view', async () => {
	const p = page({ mode: 'radius' });
	await settle();
	await p.toggleDisplay(true);
	p.el('spatial-view-button-stats').click();
	const cell = p.onMap()[0];
	cell.listener();
	await settle();

	assert.equal(p.calls.suppress, 1);
	assert.deepEqual(p.calls.tabs, ['spatial']);
	assert.equal(p.el('spatial-view-grid').hidden, false);  // switched back to the grid view
	assert.equal(p.el('grid-detail').hidden, false);
	assert.match(p.el('grid-detail').textContent, /셀 점유율/);
	assert.match(p.el('grid-detail').textContent, /원 안 면적/);
});

test('cell clicks are ignored while measuring', async () => {
	const p = page({ mode: 'distance' });
	await settle();
	await p.toggleDisplay(true);
	p.onMap()[0].listener();
	await settle();
	assert.equal(p.calls.suppress, 0);
	assert.equal(p.el('grid-detail').hidden, true);
});

test('measurement reset redraws the grid (only while it is on)', async () => {
	const p = page();
	await settle();
	await p.toggleDisplay(true);
	const before = p.created.length;
	p.emit('gis:measurereset');
	await settle();
	assert.equal(p.created.length, before + 8);
	assert.equal(p.onMap().length, 8);

	await p.toggleDisplay(false);
	p.emit('gis:measurereset');
	await settle();
	assert.equal(p.onMap().length, 0);
	assert.equal(p.clearCalls(), 0);
});

test('a new analysis clears the grid and unchecks the display', async () => {
	const p = page();
	await settle();
	await p.toggleDisplay(true);
	p.emit('gis:analysisresult', { generation: 2, source: 'saved', analysisId: 12, radius: 100 });
	await settle();

	assert.equal(p.onMap().length, 0);
	assert.equal(p.el('grid-display').checked, false);
	assert.deepEqual(p.calls.buildings, [false, true]);
	await p.toggleDisplay(true);
	assert.match(p.gridRequests().at(-1), /^\/api\/analyses\/12\/grid-density\?cellSize=100/);
});

test('410 expired snapshot: message, display unchecked, buildings back', async () => {
	const p = page({ route: (url) => (url.includes('/grid-density') ? [410, { error: 'SNAPSHOT_EXPIRED', message: 'x' }] : null) });
	await settle();
	await p.toggleDisplay(true);

	assert.match(p.el('grid-status').textContent, /만료/);
	assert.match(p.el('grid-status').className, /is-error/);
	assert.equal(p.el('grid-retry').hidden, true);  // not retryable
	assert.equal(p.el('grid-display').checked, false);
	assert.deepEqual(p.calls.buildings, [false, true]);
	assert.equal(p.onMap().length, 0);
});

test('503 service busy: message with retry', async () => {
	const p = page({ route: (url) => (url.includes('/grid-density') ? [503, { error: 'ANALYSIS_SERVICE_BUSY' }] : null) });
	await settle();
	await p.toggleDisplay(true);
	assert.match(p.el('grid-status').textContent, /다른 분석을 처리/);
	assert.equal(p.el('grid-retry').hidden, false);
});

test('python not available: the display switch is disabled', async () => {
	const p = page({ route: (url) => (url.endsWith('/spatial-analysis/status') ? [200, { available: false, configured: true }] : null) });
	await settle();
	assert.equal(p.el('grid-display').disabled, true);
	await p.toggleDisplay(true);  // even if the change event fires
	assert.equal(p.el('grid-display').checked, false);
	assert.equal(p.gridRequests().length, 0);
	assert.match(p.el('grid-status').textContent, /사용할 수 없어/);
});

test('integrity problems and partial results are explained', async () => {
	const p = page({ route: (url) => (url.includes('/grid-density')
		? [200, gridFor(100, (r) => {
			r.cells.features[2].geometry.coordinates = [[[999, 0], [1, 1], [2, 2], [999, 0]]];
			r.completeness.complete = false;
		})] : null) });
	await settle();
	await p.toggleDisplay(true);

	assert.equal(p.el('grid-notices').hidden, false);
	assert.match(p.el('grid-notices').textContent, /올바르지 않은 셀 1개/);
	assert.match(p.el('grid-notices').textContent, /부분 조회 결과/);
});

test('without an analysis the grid controls are disabled', async () => {
	const p = page({ noAnalysis: true });
	await settle();
	assert.equal(p.el('grid-empty').hidden, false);
	assert.equal(p.el('grid-display').disabled, true);
	assert.equal(p.el('grid-size-50').disabled, true);
});
