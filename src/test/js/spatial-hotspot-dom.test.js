// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The hotspot view in the page: spatial-api.js -> spatial-views.js -> spatial-dashboard.js -> spatial-compare.js
// -> spatial-grid-renderer.js -> spatial-grid.js -> spatial-hotspot.js, as index.jsp loads them, in a vm sandbox with a
// minimal fake DOM, a fake VWorld map and a fake Java API. map-analysis.js is replaced by a stub.
// Real VWorld rendering is checked in the browser (8-7-6).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');
const CSS = path.join(__dirname, '../../main/resources/static/css/main.css');
const JSP = path.join(__dirname, '../../main/webapp/WEB-INF/views/index.jsp');
const model = require(path.join(JS, 'spatial-grid-renderer.js'));
const HOTSPOT = require('./fixtures/hotspot-350m-50.json');  // real response: OK, 185 cells, all eight classes
const GRID = require('./fixtures/grid-density-100m-50.json');
const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOTSPOT_RGBA = new Set(Object.values(model.HOTSPOT_COLORS).map((c) => c.join(',')));

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
}

// As index.jsp renders them: hidden at first.
const HIDDEN = ['spatial-section', 'spatial-view-grid', 'spatial-view-hotspot', 'spatial-view-compare', 'grid-status',
	'grid-retry', 'grid-summary', 'grid-notices', 'grid-detail', 'spatial-status', 'spatial-retry', 'spatial-result',
	'spatial-warnings-title', 'spatial-warnings', 'history-compare', 'compare-selection', 'compare-status',
	'compare-retry', 'compare-result', 'compare-reasons', 'compare-warnings-title', 'compare-warnings', 'hotspot-status',
	'hotspot-retry', 'hotspot-notice', 'hotspot-result', 'hotspot-moran', 'hotspot-notices', 'hotspot-detail',
	'hotspot-limitations'];

function settle() {
	return new Promise((resolve) => setTimeout(resolve, 30));
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function okFor(size, change) {
	const body = clone(HOTSPOT);
	body.result.cellSizeMeters = size;
	if (change) {
		change(body.result);
	}
	return body;
}

function blockedFor(size, options = {}) {
	return okFor(size, (r) => {
		r.status = 'PARTIAL_RESULT_BLOCKED';
		r.blockedReasons = options.blockedReasons || ['PAGE_LIMIT'];
		r.grid = null;
		r.counts = null;
		r.moran = null;
		Object.keys(r.summary.classes).forEach((k) => { r.summary.classes[k] = 0; });
		Object.keys(r.summary.notTestedReasons).forEach((k) => { r.summary.notTestedReasons[k] = 0; });
		Object.assign(r.summary, { cellCount: 0, studyCellCount: 0, testedCellCount: 0 });
		r.completeness = { complete: false, scope: 'OBSERVED_BUILDINGS_ONLY',
			reasons: options.reasons || [{ code: 'PAGE_LIMIT', message: '조회 페이지 상한에 도달해 일부 건물만 조회했습니다.' }],
			notes: [], sourceComplete: options.sourceComplete === true,
			pythonGeometryExcluded: options.excluded == null ? null : options.excluded };
		r.warnings = [{ code: 'PARTIAL_RESULT_BLOCKED', message: '부분 조회 결과는 핫스팟을 계산하지 않았습니다.', count: null }];
		r.cells.features = [];
	});
}

function notTestedFor(size, status, study) {
	return okFor(size, (r) => {
		r.status = status;
		r.moran = null;
		r.cells.features.forEach((f) => Object.assign(f.properties, { hotspotClass: 'NOT_TESTED', giZ: null, pValue: null,
			qValue: null, bin: null, reason: f.properties.smallBoundary ? 'SMALL_BOUNDARY' : status }));
		Object.keys(r.summary.classes).forEach((k) => { r.summary.classes[k] = 0; });
		r.summary.classes.NOT_TESTED = 185;
		r.summary.studyCellCount = study;
		r.summary.testedCellCount = 0;
		r.summary.notTestedReasons[status] = 161;
		r.warnings = [{ code: status, message: status + ' 경고 문구', count: study }];
	});
}

function page(options = {}) {
	const elements = {};
	const element = (id) => {
		if (!elements[id]) {
			elements[id] = new FakeElement(id.includes('size') || id.endsWith('-run') || id.endsWith('-clear')
				|| id.endsWith('-retry') ? 'button' : 'div', id);
			elements[id].hidden = HIDDEN.includes(id);
		}
		return elements[id];
	};
	[['spatial-view-button-stats', 'data-view', 'stats'], ['spatial-view-button-grid', 'data-view', 'grid'],
		['spatial-view-button-hotspot', 'data-view', 'hotspot'], ['spatial-view-button-compare', 'data-view', 'compare'],
		['grid-size-50', 'data-cell-size', '50'], ['grid-size-100', 'data-cell-size', '100'],
		['grid-size-200', 'data-cell-size', '200'], ['hotspot-size-50', 'data-cell-size', '50'],
		['hotspot-size-100', 'data-cell-size', '100'], ['hotspot-size-200', 'data-cell-size', '200']]
		.forEach(([id, name, value]) => element(id).setAttribute(name, value));
	element('grid-exclude-empty').checked = true;
	element('hotspot-run').disabled = true;
	element('hotspot-clear').disabled = true;
	const listeners = {};
	const requests = [];
	const held = [];
	const document = {
		currentScript: null,
		getElementById: element,
		createElement: (tag) => new FakeElement(tag),
		addEventListener: (type, fn) => {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event))
	};
	const created = [];
	const removed = [];
	class PolygonZ {
		constructor(c) {
			this.points = c.items;
		}

		setFillColor(color) {
			this.color = color;
		}

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
	let mode = options.mode || 'select';
	let route = options.route || (() => null);
	function answerFor(url) {
		const custom = route(url);
		if (custom) {
			return custom;
		}
		if (url.endsWith('/spatial-analysis/status')) {
			return [200, { available: options.unavailable ? false : true, configured: true }];
		}
		if (url.includes('/grid-density')) {
			const body = clone(GRID);
			body.result.cellSizeMeters = Number(url.match(/cellSize=(\d+)/)[1]);
			return [200, body];
		}
		if (url.includes('/hotspot')) {
			return [200, okFor(Number(url.match(/cellSize=(\d+)/)[1]))];
		}
		return [404, { error: 'ANALYSIS_NOT_FOUND' }];
	}
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
			Coord: class { constructor(x, y) { this.v = [x, y]; } },
			Color: class { constructor(r, g, b, a) { this.rgba = [r, g, b, a]; } } },
		gisMap: map,
		gisTools: { getMode: () => mode },
		gisAnalysis: {
			getCurrent: () => (options.noAnalysis ? null
				: { generation: 1, source: 'live', analysisToken: TOKEN, radius: 350 }),
			suppressNextMapClick: () => calls.suppress++,
			formatDateTime: (iso) => iso,
			openInfoPanel: (tab) => {
				calls.tabs.push(tab);
				document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab } }));
			}
		},
		gisAnalysisRenderer: { setBuildingsVisible: (v) => calls.buildings.push(v) },
		fetch(url, init) {
			requests.push(url);
			return new Promise((resolve, reject) => {
				const respond = () => {
					const [status, body] = answerFor(url);
					resolve({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
				};
				if (init && init.signal) {
					init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
				}
				if (options.hold && options.hold(url)) {
					held.push({ url, respond });
				} else {
					respond();
				}
			});
		}
	};
	window.window = window;
	const context = vm.createContext(window);
	const load = (file, base) => {
		document.currentScript = { getAttribute: (name) => (name === 'data-api-base' && base ? '/api' : null) };
		vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
	};
	load('spatial-api.js');
	load('spatial-views.js');
	load('spatial-dashboard.js', true);
	load('spatial-compare.js', true);
	load('spatial-grid-renderer.js');
	load('spatial-grid.js', true);
	load('spatial-hotspot.js', true);
	const onMap = () => created.filter((o) => !removed.includes(o));
	const isHotspot = (o) => o.color && HOTSPOT_RGBA.has(o.color.rgba.join(','));
	return {
		el: element, window, requests, created, removed, calls, onMap, held, load, listeners,
		hotspotOnMap: () => onMap().filter(isHotspot),
		gridOnMap: () => onMap().filter((o) => !isHotspot(o)),
		clearCalls: () => clearCalls,
		setMode: (m) => {
			mode = m;
		},
		setRoute: (fn) => {
			route = fn;
		},
		emit: (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail })),
		hotspotRequests: () => requests.filter((r) => r.includes('/hotspot')),
		state: () => window.gisSpatialHotspot.getState(),
		async openHotspot() {
			element('spatial-view-button-hotspot').click();
			element('spatial-section').hidden = false;
			document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab: 'spatial' } }));
			await settle();
		},
		async run(size) {
			if (size) {
				element('hotspot-size-' + size).click();
			}
			element('hotspot-run').click();
			await settle();
		},
		async releaseHeld(match) {
			const i = held.findIndex((h) => h.url.includes(match));
			held.splice(i, 1)[0].respond();
			await settle();
		}
	};
}

const text = (el) => el.textContent;
const legendItems = (p) => p.el('hotspot-legend').children.concat(p.el('hotspot-legend-untested').children);

/* ---------- view and controls ---------- */

test('the hotspot view: button and panel, nothing requested by itself, legend with 7 levels and NOT_TESTED apart', async () => {
	const p = page();
	await settle();
	await p.openHotspot();

	assert.equal(p.el('spatial-view-hotspot').hidden, false);
	for (const other of ['stats', 'grid', 'compare']) {
		assert.equal(p.el('spatial-view-' + other).hidden, true, other);
		assert.equal(p.el('spatial-view-button-' + other).getAttribute('aria-pressed'), 'false');
	}
	assert.equal(p.el('spatial-view-button-hotspot').getAttribute('aria-pressed'), 'true');
	assert.equal(p.hotspotRequests().length, 0);
	assert.ok(!p.requests.some((r) => r.includes('/statistics')), 'statistics only in the statistics view');
	assert.equal(p.el('hotspot-empty').hidden, true);
	assert.equal(p.el('hotspot-run').disabled, false);
	assert.equal(p.el('hotspot-clear').disabled, true);
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'idle');
	assert.equal(p.el('spatial-view-hotspot').getAttribute('aria-busy'), 'false');
	assert.equal(p.el('hotspot-size-100').getAttribute('aria-pressed'), 'true');

	const scale = p.el('hotspot-legend').children;
	const untested = p.el('hotspot-legend-untested').children;
	assert.deepEqual(scale.map((li) => li.getAttribute('data-legend')),
		['HOT_99', 'HOT_95', 'HOT_90', 'NOT_SIGNIFICANT', 'COLD_90', 'COLD_95', 'COLD_99']);
	assert.deepEqual(untested.map((li) => li.getAttribute('data-legend')), ['NOT_TESTED']);
	model.hotspotLegend().forEach((item) => {
		const li = legendItems(p).find((l) => l.getAttribute('data-legend') === item.key);
		assert.equal(li.children[1].textContent, item.label, 'a name next to every color');
		assert.equal(li.children[0].style.backgroundColor, 'rgba(' + item.rgba.slice(0, 3).join(', ') + ', '
			+ (item.rgba[3] / 255).toFixed(2) + ')');
		assert.equal(li.children[2].textContent, '', 'no counts before a result');
	});
	assert.notEqual(scale[3].children[0].style.backgroundColor, untested[0].children[0].style.backgroundColor);
	assert.match(scale[3].textContent, /유의하지 않음 \(검정함\)/);
	assert.match(untested[0].textContent, /검정하지 않음/);
});

test('without an analysis: guidance shown, size and run buttons disabled', async () => {
	const p = page({ noAnalysis: true });
	await settle();
	await p.openHotspot();
	assert.equal(p.el('hotspot-empty').hidden, false);
	assert.equal(p.el('hotspot-run').disabled, true);
	assert.ok([50, 100, 200].every((s) => p.el('hotspot-size-' + s).disabled));
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'empty');
	p.el('hotspot-run').click();
	await settle();
	assert.equal(p.hotspotRequests().length, 0);
});

test('cell sizes 50 / 100 / 200: aria-pressed follows, the run uses the chosen size; snapshot token URL', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	for (const size of [50, 200, 100]) {
		p.el('hotspot-size-' + size).click();
		[50, 100, 200].forEach((s) => assert.equal(p.el('hotspot-size-' + s).getAttribute('aria-pressed'), String(s === size)));
	}
	assert.equal(p.hotspotRequests().length, 0, 'choosing a size before running requests nothing');
	await p.run(50);
	assert.deepEqual(p.hotspotRequests(), ['/api/analysis-snapshots/' + TOKEN + '/hotspot?cellSize=50']);
	// After a result, another size runs at once.
	p.el('hotspot-size-200').click();
	await settle();
	assert.equal(p.hotspotRequests()[1], '/api/analysis-snapshots/' + TOKEN + '/hotspot?cellSize=200');
});

test('a saved analysis uses its id; saving a snapshot switches later requests to the id', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	p.emit('gis:analysisresult', { generation: 2, source: 'saved', analysisId: 42, radius: 350 });
	await p.run(100);
	assert.deepEqual(p.hotspotRequests(), ['/api/analyses/42/hotspot?cellSize=100']);

	const s = page();
	await settle();
	await s.openHotspot();
	await s.run(100);
	s.emit('gis:analysissaved', { generation: 1, analysisId: 77 });
	s.el('hotspot-size-200').click();
	await settle();
	assert.equal(s.hotspotRequests()[1], '/api/analyses/77/hotspot?cellSize=200');
});

/* ---------- results ---------- */

test('OK: cells on the map, summary cards, Moran\'s I card, legend counts, warnings and limitations', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	await p.run(50);

	assert.equal(p.hotspotOnMap().length, 185);
	assert.equal(p.gridOnMap().length, 0);
	assert.equal(p.calls.buildings[p.calls.buildings.length - 1], false);
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'ok');
	assert.equal(p.el('spatial-view-hotspot').getAttribute('aria-busy'), 'false');
	assert.equal(p.el('hotspot-status').hidden, true);
	assert.equal(p.el('hotspot-notice').hidden, true);
	assert.equal(p.el('hotspot-result').hidden, false);
	assert.equal(text(p.el('hotspot-summary')), '셀 50m · 표시 185개 / 전체 185개');
	assert.deepEqual(p.el('hotspot-kpis').children.map((k) => [k.children[0].textContent, k.children[1].textContent]),
		[['핫스팟 셀', '15개'], ['콜드스팟 셀', '14개'], ['검정한 셀', '161개'], ['전체 셀', '185개']]);
	assert.match(text(p.el('hotspot-kpis').children[2]), /연구 셀 161개/);

	assert.equal(p.el('hotspot-moran').hidden, false);
	const moran = p.el('hotspot-moran-list').children.map((row) => [row.children[0].textContent, row.children[1].textContent]);
	assert.deepEqual(moran, [['Moran\'s I', '0.4815'], ['기대값 E[I]', p.window.gisSpatialApi.formatNumber(-0.00625, 4)],
		['순열 검정 p값 (양측)', '0.001 (순열 999회에서 가능한 최솟값)'], ['순열 횟수', '999회'], ['시뮬레이션 z', '11.48']]);
	assert.match(text(p.el('hotspot-moran-text')), /양의 공간 자기상관/);
	assert.match(text(p.el('hotspot-moran-scope')), /셀 색상\(셀별 Getis-Ord Gi\*\)과는 다른 통계/);

	const counts = Object.fromEntries(legendItems(p).map((li) => [li.getAttribute('data-legend'), li.children[2].textContent]));
	assert.deepEqual(counts, { HOT_99: '8개', HOT_95: '3개', HOT_90: '4개', NOT_SIGNIFICANT: '132개', COLD_90: '3개',
		COLD_95: '5개', COLD_99: '6개', NOT_TESTED: '24개' });
	assert.deepEqual(p.el('hotspot-notices').children.map((li) => li.textContent), [HOTSPOT.result.warnings[0].message]);
	assert.equal(p.el('hotspot-limitations').hidden, false);
	assert.equal(p.el('hotspot-limitations-list').children.length, 5);
	assert.match(text(p.el('hotspot-method')), /Getis-Ord Gi\*/);
	assert.equal(p.el('hotspot-clear').disabled, false);
	assert.equal(p.clearCalls(), 0, 'map.clear() is never called');
});

test('PARTIAL_RESULT_BLOCKED: earlier cells removed, statistics and legend counts hidden, reasons and completeness shown', async () => {
	const p = page({ route: (url) => (url.includes('/hotspot?cellSize=100') ? [200, blockedFor(100)] : null) });
	await settle();
	await p.openHotspot();
	await p.run(50);
	assert.equal(p.hotspotOnMap().length, 185);
	p.el('hotspot-size-100').click();
	await settle();

	assert.equal(p.hotspotOnMap().length, 0);
	assert.equal(p.calls.buildings[p.calls.buildings.length - 1], true, 'analysis buildings shown again');
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'partial_result_blocked');
	assert.equal(p.el('hotspot-result').hidden, true);
	assert.equal(p.el('hotspot-moran').hidden, true);
	assert.equal(p.el('hotspot-moran-list').children.length, 0);
	assert.ok(legendItems(p).every((li) => li.children[2].textContent === ''), 'no legend counts');
	assert.equal(p.el('hotspot-status').hidden, false);
	assert.match(text(p.el('hotspot-status')), /^\[부분 결과 차단\] 부분 조회 결과라 핫스팟과 Moran's I를 계산하지 않았습니다/);
	assert.equal(p.el('hotspot-notice').hidden, false);
	const notice = text(p.el('hotspot-notice'));
	assert.match(notice, /부분 조회 결과라 핫스팟을 분석하지 않았습니다/);
	assert.match(notice, /조회 페이지 상한에 도달해 일부 건물만 조회했습니다/);
	assert.match(notice, /원본 반경 분석부분 조회/);
	assert.match(notice, /핫스팟 입력불완전 \(분석 차단\)/);
	assert.deepEqual(p.el('hotspot-notices').children.map((li) => li.textContent), ['부분 조회 결과는 핫스팟을 계산하지 않았습니다.']);
	assert.ok(!/핫스팟 셀|콜드스팟 셀/.test(text(p.el('spatial-view-hotspot'))), 'no hotspot counts anywhere');

	const g = page({ route: (url) => (url.includes('/hotspot') ? [200, blockedFor(100, { blockedReasons: ['PYTHON_GEOMETRY_EXCLUDED'],
		reasons: [], sourceComplete: true, excluded: 3 })] : null) });
	await settle();
	await g.openHotspot();
	await g.run();
	assert.match(text(g.el('hotspot-notice')), /복구할 수 없는 건물 도형이 3개 있어/);
	assert.match(text(g.el('hotspot-notice')), /분석 서버가 제외한 건물 도형3개/);
	assert.match(text(g.el('hotspot-notice')), /원본 반경 분석전체 조회/);
	assert.equal(g.hotspotOnMap().length, 0);
});

test('CONSTANT_VALUES and INSUFFICIENT_CELLS: explained with the response numbers, nothing on the map, no Moran', async () => {
	for (const [status, study, pattern] of [['CONSTANT_VALUES', 161, /\[분석 불가\] 모든 셀의 점유율이 같아\(분산 0/],
		['INSUFFICIENT_CELLS', 12, /\[분석 불가\] 검정할 수 있는 셀이 12개로 최소 30개보다 적어/]]) {
		const p = page({ route: (url) => (url.includes('/hotspot') ? [200, notTestedFor(100, status, study)] : null) });
		await settle();
		await p.openHotspot();
		await p.run();
		assert.equal(p.hotspotOnMap().length, 0, status);
		assert.equal(p.calls.buildings.length, 0, 'buildings never hidden');
		assert.match(text(p.el('hotspot-status')), pattern);
		assert.equal(p.el('hotspot-moran').hidden, true);
		assert.equal(p.el('hotspot-result').hidden, true);
		assert.match(text(p.el('hotspot-notice')), /핫스팟 통계가 성립하지 않습니다/);
		assert.match(text(p.el('hotspot-notice')), new RegExp('연구 셀 \\(작은 경계 셀 제외\\)' + study + '개'));
		assert.ok(legendItems(p).every((li) => li.children[2].textContent === ''));
		assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), status.toLowerCase());
	}
});

/* ---------- cells ---------- */

test('cell click: detail with Gi* z, p before and q after correction; NOT_TESTED shows its reason; no new radius center', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	await p.run(50);
	const hot = p.hotspotOnMap().find((o) => o.color.rgba.join(',') === model.HOTSPOT_COLORS.HOT_99.join(','));
	hot.listener();
	await settle();

	assert.equal(p.calls.suppress, 1);
	assert.deepEqual(p.calls.tabs, ['spatial']);
	assert.equal(p.el('spatial-view-hotspot').hidden, false, 'still the hotspot view');
	assert.equal(p.hotspotOnMap().length, 185, 'opening the view again does not clear the cells');
	const detail = p.el('hotspot-detail');
	assert.equal(detail.hidden, false);
	const labels = detail.children[1].children.map((row) => row.children[0].textContent);
	assert.deepEqual(labels, ['분류', 'Gi* z점수', 'p값 (정규 근사, 보정 전)', 'q값 (다중 검정 보정, 분류 기준)', '이웃 셀 수',
		'셀 점유율', '원 안 면적 비율', '위치']);
	assert.equal(detail.children[1].children[0].children[1].textContent, '핫스팟 (신뢰수준 99%)');
	assert.match(text(detail), /Benjamini-Hochberg/);

	const untested = p.hotspotOnMap().find((o) => o.color.rgba.join(',') === model.HOTSPOT_COLORS.NOT_TESTED.join(','));
	untested.listener();
	await settle();
	const rows = p.el('hotspot-detail').children[1].children.map((row) => row.children[0].textContent);
	assert.deepEqual(rows, ['분류', '검정하지 않은 사유', '셀 점유율', '원 안 면적 비율', '위치']);
	assert.ok(!/Gi\* z점수|q값/.test(text(p.el('hotspot-detail'))));
	// A new result replaces the detail.
	p.el('hotspot-size-200').click();
	await settle();
	assert.equal(p.el('hotspot-detail').hidden, true);
});

test('cell clicks are ignored while measuring or reading coordinates', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	await p.run(50);
	for (const mode of ['distance', 'area', 'coord']) {
		p.setMode(mode);
		p.hotspotOnMap()[0].listener();
		await settle();
		assert.equal(p.el('hotspot-detail').hidden, true, mode);
	}
	assert.equal(p.calls.suppress, 0);
	assert.deepEqual(p.calls.tabs, []);
});

test('measurement reset redraws the hotspot cells (only while they are shown)', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	p.emit('gis:measurereset');
	await settle();
	assert.equal(p.created.length, 0);
	await p.run(50);
	const before = p.created.length;
	p.emit('gis:measurereset');
	await settle();
	assert.equal(p.created.length, before + 185);
	assert.equal(p.hotspotOnMap().length, 185);
	assert.equal(p.clearCalls(), 0);
});

/* ---------- map layers and views ---------- */

test('grid and hotspot are never on the map together; the buildings stay hidden exactly while one is shown', async () => {
	const p = page();
	await settle();
	// Grid on in the grid view; it stays on in other views.
	p.el('spatial-view-button-grid').click();
	p.el('grid-display').checked = true;
	p.el('grid-display').dispatch('change');
	await settle();
	assert.equal(p.gridOnMap().length, 8);
	await p.openHotspot();
	assert.equal(p.gridOnMap().length, 8, 'the grid stays when the view changes');
	// Hotspot run: the grid goes off first.
	await p.run(50);
	assert.equal(p.gridOnMap().length, 0);
	assert.equal(p.hotspotOnMap().length, 185);
	assert.equal(p.el('grid-display').checked, false, 'the grid switch is unchecked');
	assert.equal(p.calls.buildings[p.calls.buildings.length - 1], false);
	// Back to the grid view: the hotspot cells are cleared; grid on again.
	p.el('spatial-view-button-grid').click();
	await settle();
	assert.equal(p.hotspotOnMap().length, 0);
	assert.equal(p.calls.buildings[p.calls.buildings.length - 1], true);
	p.el('grid-display').checked = true;
	p.el('grid-display').dispatch('change');
	await settle();
	assert.equal(p.gridOnMap().length, 8);
	assert.equal(p.hotspotOnMap().length, 0);
	assert.equal(p.calls.buildings[p.calls.buildings.length - 1], false);
	assert.equal(p.clearCalls(), 0);
});

test('leaving the hotspot view clears its cells and result; coming back draws from the cache', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	await p.run(50);
	for (const view of ['stats', 'compare']) {
		p.el('spatial-view-button-' + view).click();
		await settle();
		assert.equal(p.hotspotOnMap().length, 0, view);
		assert.equal(p.el('hotspot-moran').hidden, true);
		assert.equal(p.el('hotspot-result').hidden, true);
		assert.equal(p.calls.buildings[p.calls.buildings.length - 1], true);
		await p.openHotspot();
		await p.run();
		assert.equal(p.hotspotOnMap().length, 185);
	}
	assert.equal(p.hotspotRequests().length, 1, 'drawn again from the cache');
	assert.ok(p.removed.filter((o) => HOTSPOT_RGBA.has(o.color.rgba.join(','))).every((o) => o.listener === null));
});

test('loading: aria-busy, run disabled against double requests; a late answer for an old size is ignored', async () => {
	const p = page({ hold: (url) => url.includes('/hotspot') });
	await settle();
	await p.openHotspot();
	await p.run(50);
	assert.equal(p.el('spatial-view-hotspot').getAttribute('aria-busy'), 'true');
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'loading');
	assert.equal(p.el('hotspot-run').disabled, true);
	assert.match(text(p.el('hotspot-status')), /^\[분석 중\] 격자 핫스팟을 계산하고 있습니다... \(셀 50m\)/);
	p.el('hotspot-run').click();
	await settle();
	assert.equal(p.hotspotRequests().length, 1);

	p.el('hotspot-size-200').click();
	await settle();
	assert.equal(p.hotspotRequests().length, 2);
	await p.releaseHeld('cellSize=50');  // aborted: the late answer is ignored
	assert.equal(p.hotspotOnMap().length, 0);
	await p.releaseHeld('cellSize=200');
	assert.equal(p.hotspotOnMap().length, 185);
	assert.match(text(p.el('hotspot-summary')), /^셀 200m/);
	assert.equal(p.el('spatial-view-hotspot').getAttribute('aria-busy'), 'false');

	// A late answer after leaving the view is ignored too.
	const v = page({ hold: (url) => url.includes('/hotspot') });
	await settle();
	await v.openHotspot();
	await v.run(100);
	v.el('spatial-view-button-stats').click();
	await v.releaseHeld('cellSize=100');
	assert.equal(v.hotspotOnMap().length, 0);
	assert.equal(v.state().outcome, null);
});

test('server errors: describeError text, retry only when it can help, no earlier result left', async () => {
	let busy = true;
	const p = page({ route: (url) => (url.includes('/hotspot?cellSize=100') && busy
		? [503, { error: 'ANALYSIS_SERVICE_BUSY' }] : null) });
	await settle();
	await p.openHotspot();
	await p.run(50);
	assert.equal(p.hotspotOnMap().length, 185);
	p.el('hotspot-size-100').click();
	await settle();
	assert.equal(p.hotspotOnMap().length, 0, 'no earlier result left');
	assert.equal(p.el('hotspot-moran').hidden, true);
	assert.match(text(p.el('hotspot-status')), new RegExp('^\\[오류\\] ' + p.window.gisSpatialApi.MESSAGES.ANALYSIS_SERVICE_BUSY));
	assert.equal(p.el('spatial-view-hotspot').getAttribute('data-state'), 'error');
	assert.equal(p.el('hotspot-retry').hidden, false);
	busy = false;
	p.el('hotspot-retry').click();
	await settle();
	assert.equal(p.hotspotOnMap().length, 185);
	assert.equal(p.el('hotspot-retry').hidden, true);
	assert.equal(p.el('hotspot-status').hidden, true);

	const expired = page({ route: (url) => (url.includes('/hotspot') ? [410, { error: 'SNAPSHOT_EXPIRED' }] : null) });
	await settle();
	await expired.openHotspot();
	await expired.run();
	assert.match(text(expired.el('hotspot-status')), /만료/);
	assert.equal(expired.el('hotspot-retry').hidden, true, 'retrying an expired snapshot cannot help');
});

test('python not available: run disabled with a labelled message, nothing requested', async () => {
	const p = page({ unavailable: true });
	await settle();
	await p.openHotspot();
	assert.equal(p.state().service, 'unavailable');
	assert.equal(p.el('hotspot-run').disabled, true);
	p.el('hotspot-run').click();
	await settle();
	assert.equal(p.hotspotRequests().length, 0);
});

test('clear button: cells, result and detail gone, buildings back; listeners removed after repeated runs', async () => {
	const p = page();
	await settle();
	await p.openHotspot();
	for (let i = 0; i < 4; i++) {
		await p.run(i % 2 ? 100 : 50);
		assert.equal(p.hotspotOnMap().length, 185);
		p.el('hotspot-clear').click();
		await settle();
		assert.equal(p.hotspotOnMap().length, 0);
		assert.equal(p.el('hotspot-result').hidden, true);
		assert.equal(p.el('hotspot-clear').disabled, true);
		assert.equal(p.calls.buildings[p.calls.buildings.length - 1], true);
	}
	assert.equal(p.hotspotRequests().length, 2, 'two sizes, each requested once');
	assert.ok(p.created.every((o) => o.listener === null), 'every click listener removed');
	assert.equal(p.clearCalls(), 0);
});

/* ---------- page wiring, regressions, markup ---------- */

test('one hotspot renderer per page: loading the script again changes nothing', async () => {
	const p = page();
	await settle();
	const first = p.window.gisSpatialHotspot;
	assert.equal(p.listeners['gis:mapready'].length, 2, 'grid renderer + hotspot renderer');
	const counts = Object.fromEntries(Object.entries(p.listeners).map(([k, v]) => [k, v.length]));
	const clicks = p.el('hotspot-run').listeners.click.length;
	p.load('spatial-hotspot.js', true);
	assert.equal(p.window.gisSpatialHotspot, first);
	assert.deepEqual(Object.fromEntries(Object.entries(p.listeners).map(([k, v]) => [k, v.length])), counts);
	assert.equal(p.el('hotspot-run').listeners.click.length, clicks);
	assert.equal(p.el('hotspot-legend').children.length, 7, 'the legend is not built twice');
});

test('stats, grid and compare still work with the hotspot module loaded', async () => {
	const p = page();
	await settle();
	p.el('spatial-section').hidden = false;
	p.emit('gis:tabchange', { tab: 'spatial' });
	await settle();
	assert.ok(p.requests.some((r) => r.includes('/statistics')), 'the statistics view requests its statistics');
	p.el('spatial-view-button-grid').click();
	p.el('grid-display').checked = true;
	p.el('grid-display').dispatch('change');
	await settle();
	assert.equal(p.gridOnMap().length, 8);
	p.el('spatial-view-button-compare').click();
	await settle();
	assert.equal(p.el('spatial-view-compare').hidden, false);
	assert.equal(p.gridOnMap().length, 8, 'the grid stays on in other views');
	assert.equal(p.hotspotRequests().length, 0);
	p.el('spatial-view-button-stats').click();
	assert.equal(p.el('spatial-view-stats').hidden, false);
	assert.equal(p.el('spatial-view-hotspot').hidden, true);
});

test('index.jsp: hotspot markup, accessibility attributes and script order', () => {
	const jsp = fs.readFileSync(JSP, 'utf8');
	assert.match(jsp, /id="spatial-view-button-hotspot" data-view="hotspot"\s+aria-pressed="false" aria-controls="spatial-view-hotspot">핫스팟</);
	assert.match(jsp, /id="spatial-view-hotspot" data-state="empty" aria-busy="false" hidden/);
	assert.match(jsp, /id="hotspot-status" role="status" aria-live="polite" hidden/);
	assert.match(jsp, /role="group" aria-label="핫스팟 셀 크기"/);
	for (const size of [50, 100, 200]) {
		assert.match(jsp, new RegExp('id="hotspot-size-' + size + '" data-cell-size="' + size + '" aria-pressed="(true|false)"'));
	}
	for (const id of ['hotspot-empty', 'hotspot-run', 'hotspot-clear', 'hotspot-retry', 'hotspot-notice', 'hotspot-result',
		'hotspot-kpis', 'hotspot-moran', 'hotspot-moran-list', 'hotspot-notices', 'hotspot-detail', 'hotspot-legend',
		'hotspot-legend-untested', 'hotspot-limitations', 'hotspot-limitations-list', 'hotspot-method']) {
		assert.equal(jsp.split('id="' + id + '"').length, 2, id);
	}
	// Buttons are real <button>s (keyboard), the limits a <details> (keyboard toggle).
	assert.match(jsp, /<button type="button" class="tool-bar__button tool-bar__button--primary" id="hotspot-run"/);
	assert.match(jsp, /<details class="hotspot-limitations" id="hotspot-limitations" hidden>\s*<summary>/);
	const at = (file) => jsp.indexOf('/js/' + file + '"');
	assert.ok(at('spatial-grid.js') < at('spatial-hotspot.js'), 'after spatial-grid.js');
	assert.ok(at('spatial-hotspot.js') < at('vworld-map.js'), 'before vworld-map.js (gis:mapready)');
	assert.match(jsp, /js\/spatial-hotspot\.js"\s+data-api-base="\$\{pageContext\.request\.contextPath\}\/api"/);
	const block = jsp.slice(jsp.indexOf('<c:if test="${vworldEnabled}">'), jsp.indexOf('</c:if>', jsp.indexOf('<c:if test="${vworldEnabled}">')));
	assert.ok(block.includes('/js/spatial-hotspot.js"'), 'only with a VWorld key');
});

test('main.css: hotspot layout at 900 px and 600 px, 44 px touch targets, no horizontal overflow', () => {
	const css = fs.readFileSync(CSS, 'utf8');
	const section = css.slice(css.indexOf('/* ---------- 격자 핫스팟 보기 (8-7-5) ---------- */'),
		css.indexOf('/* ---------- 반응형 ---------- */'));
	assert.ok(section.length > 0);
	const media = (width) => {
		const start = section.indexOf('@media (max-width: ' + width + 'px)');
		assert.ok(start >= 0, width + 'px rules');
		let depth = 0;
		for (let i = section.indexOf('{', start); i < section.length; i++) {
			depth += section[i] === '{' ? 1 : section[i] === '}' ? -1 : 0;
			if (depth === 0) {
				return section.slice(start, i + 1);
			}
		}
		return '';
	};
	const tablet = media(900);
	for (const selector of ['.hotspot-actions .tool-bar__button', '.hotspot-view .grid-controls__sizes .tool-bar__button',
		'.hotspot-view .building-status__retry', '.hotspot-limitations summary']) {
		assert.ok(tablet.includes(selector), selector);
	}
	assert.match(tablet, /min-height: 44px/);
	const phone = media(600);
	assert.match(phone, /\.hotspot-actions \{\s*flex-direction: column;/);
	assert.match(phone, /grid-template-columns: minmax\(0, 1fr\)/);
	// Long values wrap instead of widening the panel.
	assert.match(section, /\.hotspot-moran__text \{[^}]*overflow-wrap: anywhere/);
	assert.match(section, /\.hotspot-legend__item \.grid-legend__label \{[^}]*overflow-wrap: anywhere/);
	assert.match(section, /\.hotspot-actions \.tool-bar__button \{[^}]*min-width: 0/);
	// Hidden parts stay hidden; NOT_TESTED is separated by a line, the status kind by a border and a label.
	assert.match(section, /\.hotspot-moran\[hidden\]/);
	assert.match(section, /\.hotspot-legend--untested \{[^}]*border-top: 1px dashed/);
	assert.match(section, /\.hotspot-status\.is-error \{[^}]*border-left-style: double/);
});
