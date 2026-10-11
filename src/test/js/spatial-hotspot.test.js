// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// spatial-hotspot.js (8-7-5a): response checks, screen values and the controller with the real
// spatial-grid-renderer.js on a fake VWorld map and a fake Java API. The panel DOM is connected in 8-7-5b.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');
const api = require(path.join(JS, 'spatial-api.js'));
const model = require(path.join(JS, 'spatial-grid-renderer.js'));
const gridView = require(path.join(JS, 'spatial-grid.js'));
const hotspot = require(path.join(JS, 'spatial-hotspot.js'));
// A real hotspot response (Python compute_hotspot, r = 350 m, 50 m cells): status OK, 185 cells, all eight classes,
// Moran's I 0.481477 with p = 0.001 (999 permutations).
const HOTSPOT = require('./fixtures/hotspot-350m-50.json');
const GRID = require('./fixtures/grid-density-100m-50.json');

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/** The OK fixture as the answer for another cell size (only the size fields change). */
function okFor(size, change) {
	const body = clone(HOTSPOT);
	body.result.cellSizeMeters = size;
	if (change) {
		change(body.result);
	}
	return body;
}

/** CONSTANT_VALUES / INSUFFICIENT_CELLS as Python returns them: every cell NOT_TESTED, no Moran's I. */
function notTestedFor(size, status, studyCellCount) {
	return okFor(size, (r) => {
		const n = r.cells.features.length;
		r.status = status;
		r.moran = null;
		r.cells.features.forEach((f) => {
			const p = f.properties;
			if (p.hotspotClass !== 'NOT_TESTED') {
				Object.assign(p, { hotspotClass: 'NOT_TESTED', bin: null, giZ: null, pValue: null, qValue: null,
					neighborCount: p.neighborCount, reason: status });
			}
		});
		r.summary.studyCellCount = studyCellCount;
		r.summary.testedCellCount = 0;
		r.summary.classes = { HOT_99: 0, HOT_95: 0, HOT_90: 0, NOT_SIGNIFICANT: 0, COLD_90: 0, COLD_95: 0, COLD_99: 0,
			NOT_TESTED: n };
		r.summary.notTestedReasons = { SMALL_BOUNDARY: 24, NO_NEIGHBORS: 0, UNDEFINED_VARIANCE: 0, CONSTANT_VALUES: 0,
			INSUFFICIENT_CELLS: 0 };
		r.summary.notTestedReasons[status] = n - 24;
		r.warnings = [{ code: status, message: status + ' 경고', count: studyCellCount }];
	});
}

/** PARTIAL_RESULT_BLOCKED as Python returns it (checked against compute_hotspot in 8-7-5 design). */
function blockedFor(size, options = {}) {
	const body = clone(HOTSPOT);
	const r = body.result;
	r.cellSizeMeters = size;
	r.status = 'PARTIAL_RESULT_BLOCKED';
	r.blockedReasons = options.blockedReasons || ['PAGE_LIMIT'];
	r.grid = null;
	r.counts = null;
	r.moran = null;
	r.summary = { cellCount: 0, studyCellCount: 0, testedCellCount: 0,
		classes: { HOT_99: 0, HOT_95: 0, HOT_90: 0, NOT_SIGNIFICANT: 0, COLD_90: 0, COLD_95: 0, COLD_99: 0, NOT_TESTED: 0 },
		notTestedReasons: { SMALL_BOUNDARY: 0, NO_NEIGHBORS: 0, UNDEFINED_VARIANCE: 0, CONSTANT_VALUES: 0,
			INSUFFICIENT_CELLS: 0 } };
	r.completeness = { complete: false, scope: 'OBSERVED_BUILDINGS_ONLY',
		reasons: options.reasons || [{ code: 'PAGE_LIMIT', message: '조회 페이지 상한에 도달해 일부 건물만 조회했습니다.' }],
		javaOutsideExcluded: null, javaGeometryUnavailable: null, notes: [],
		sourceComplete: options.sourceComplete === true, pythonGeometryExcluded: options.excluded == null ? null : options.excluded };
	r.warnings = [{ code: 'PARTIAL_RESULT_BLOCKED', message: '부분 조회 결과는 핫스팟을 계산하지 않았습니다.', count: null }];
	r.cells = { type: 'FeatureCollection', features: [] };
	return body;
}

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

function fakeMap() {
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
			this.listenerRemoved = true;
		}
	}
	const vw = { geom: { PolygonZ }, Collection: class { constructor(i) { this.items = i; } },
		Coord: class { constructor(x, y) { this.x = x; this.y = y; } },
		Color: class { constructor(r, g, b, a) { this.rgba = [r, g, b, a]; } } };
	let clearCalls = 0;
	const map = { removeObject: (o) => removed.push(o), clear: () => clearCalls++ };
	const frames = [];
	const env = { vw: () => vw, raf: (cb) => frames.push(cb), cancelRaf: (id) => { frames[id - 1] = null; } };
	async function drawAll() {
		for (let guard = 0; guard < 100 && frames.some(Boolean); guard++) {
			frames.splice(0, frames.length).forEach((cb) => cb && cb(0));
			await flush();
		}
		await flush();
	}
	return { map, env, created, removed, drawAll, clearCalls: () => clearCalls };
}

/** A renderer that records every render call (cells and options) and otherwise is the real one. */
function recordingRenderer(fake) {
	const renderer = model.createRenderer(fake.env);
	renderer.setMap(fake.map);
	const renders = [];
	const real = renderer.render;
	renderer.render = (cells, options) => {
		renders.push({ cells: cells.length, options });
		return real(cells, options);
	};
	return { renderer, renders };
}

function fakeFetch(calls, options = {}) {
	return (url, signal) => new Promise((resolve) => {
		const call = { url, signal, resolve, answered: false };
		calls.push(call);
		if (signal && !options.ignoreAbort) {
			signal.addEventListener('abort', () => {
				if (!call.answered) {
					call.answered = true;
					resolve({ ok: false, network: true, aborted: true });
				}
			});
		}
	});
}

function harness(options = {}) {
	const fake = fakeMap();
	const { renderer, renders } = recordingRenderer(fake);
	const calls = [];
	const order = [];
	let suppressed = 0;
	let mode = 'select';
	let statusRefreshes = 0;
	let opened = 0;
	let changes = 0;
	const controller = hotspot.createController({
		api,
		model,
		renderer,
		analysisRenderer: () => ({ setBuildingsVisible: (v) => order.push('buildings:' + v) }),
		analysis: () => ({ suppressNextMapClick: () => suppressed++ }),
		mode: () => mode,
		fetchJson: fakeFetch(calls, options),
		base: '/api',
		online: () => true,
		onChange: () => changes++,
		refreshStatus: () => statusRefreshes++,
		dispatchLayer: (layer) => order.push('layer:' + layer),
		openView: () => opened++
	});
	renderer.setPickHandler(controller.pick);
	async function answer(fragment, res) {
		const call = calls.find((c) => !c.answered && c.url.includes(fragment));
		assert.ok(call, 'no pending request for ' + fragment);
		call.answered = true;
		call.resolve(res);
		await flush();
	}
	return {
		controller, renderer, renders, calls, order, answer, ...fake,
		state: () => controller.getState(),
		suppressed: () => suppressed,
		opened: () => opened,
		changes: () => changes,
		statusRefreshes: () => statusRefreshes,
		setMode: (m) => {
			mode = m;
		},
		pending: () => calls.filter((c) => !c.answered)
	};
}

const ok = (body) => ({ ok: true, status: 200, body });
const live = (generation, token = TOKEN) => ({ generation, source: 'live', analysisToken: token, radius: 350 });
const saved = (generation, analysisId) => ({ generation, source: 'saved', analysisId, radius: 350 });

/** Analysis set, hotspot view open, service available. */
function ready(h, detail = live(1)) {
	h.controller.setService('available');
	h.controller.setAnalysis(detail);
	h.controller.setView('hotspot');
}

/** ready + run at the given size + OK answer drawn. */
async function shown(h, size = 50, detail = live(1)) {
	ready(h, detail);
	h.controller.setCellSize(size);
	h.controller.run();
	await h.answer('cellSize=' + size, ok(okFor(size)));
	await h.drawAll();
}

/* ---------- pure: targets, keys and response checks ---------- */

test('analysis target, analysis key and request key', () => {
	assert.deepEqual(hotspot.targetOf(live(3)), { generation: 3, kind: 'snapshot', analysisId: null, token: TOKEN });
	assert.deepEqual(hotspot.targetOf(saved(4, 12)), { generation: 4, kind: 'saved', analysisId: 12, token: null });
	for (const detail of [null, {}, { source: 'saved', analysisId: null }, { source: 'other' }]) {
		assert.equal(hotspot.targetOf(detail), null);
	}
	assert.equal(hotspot.analysisKey(hotspot.targetOf(live(3))), '3:token:' + TOKEN);
	assert.equal(hotspot.analysisKey(hotspot.targetOf(saved(4, 12))), '4:id:12');
	assert.equal(hotspot.analysisKey(null), null);
	assert.equal(hotspot.cacheKey('4:id:12', 50), '4:id:12:50');
	assert.equal(hotspot.cacheKey(null, 50), null);
});

test('response checks: structure, status, cell size, blocked shape and cell counts', () => {
	assert.equal(hotspot.validateResponse(HOTSPOT, 50).ok, true);
	assert.equal(hotspot.validateResponse(HOTSPOT, 100).reason, 'cellSize');
	assert.equal(hotspot.validateResponse(blockedFor(100), 100).ok, true);
	assert.equal(hotspot.validateResponse(notTestedFor(100, 'CONSTANT_VALUES', 161), 100).ok, true);
	assert.equal(hotspot.validateResponse(notTestedFor(100, 'INSUFFICIENT_CELLS', 12), 100).ok, true);
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.status = 'PARTIAL'; }), 50).reason, 'status');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.status = undefined; }), 50).reason, 'status');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.grid.returnedCellCount = 184; }), 50).reason, 'count');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.summary.cellCount = 184; }), 50).reason, 'count');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.cells.features.pop(); }), 50).reason, 'count');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.grid = null; }), 50).reason, 'count');
	assert.equal(hotspot.validateResponse(okFor(50, (r) => { r.moran = null; }), 50).reason, 'structure');
	// A blocked answer with cells, or claiming to be complete, is not trusted.
	const withCells = blockedFor(50);
	withCells.result.cells.features.push(HOTSPOT.result.cells.features[0]);
	assert.equal(hotspot.validateResponse(withCells, 50).reason, 'blocked');
	const complete = blockedFor(50);
	complete.result.completeness.complete = true;
	assert.equal(hotspot.validateResponse(complete, 50).reason, 'blocked');
	for (const body of [null, {}, { result: {} }, { result: { cells: { type: 'Feature', features: [] } } },
		okFor(50, (r) => { delete r.summary; }), okFor(50, (r) => { delete r.completeness; }),
		okFor(50, (r) => { r.blockedReasons = null; })]) {
		assert.equal(hotspot.validateResponse(body, 50).ok, false);
	}
});

/* ---------- pure: screen values ---------- */

test('OK: class counts, hot and cold totals, counts and Moran\'s I from the response only', () => {
	const view = hotspot.interpret(HOTSPOT.result, api);

	assert.equal(view.status, 'OK');
	assert.equal(view.drawable, true);
	assert.equal(view.message, '');
	assert.deepEqual(view.classes.map((c) => [c.key, c.count, c.group]), [
		['HOT_99', 8, 'hot'], ['HOT_95', 3, 'hot'], ['HOT_90', 4, 'hot'], ['NOT_SIGNIFICANT', 132, 'notSignificant'],
		['COLD_90', 3, 'cold'], ['COLD_95', 5, 'cold'], ['COLD_99', 6, 'cold'], ['NOT_TESTED', 24, 'notTested']]);
	assert.equal(view.hotCount, 15);
	assert.equal(view.coldCount, 14);
	assert.deepEqual(view.counts, { cellCount: 185, studyCellCount: 161, testedCellCount: 161, minTestedCells: 30 });
	assert.deepEqual(view.notTested, [{ reason: 'SMALL_BOUNDARY', label: hotspot.REASON_LABELS.SMALL_BOUNDARY, count: 24 }]);
	assert.equal(view.complete, true);
	assert.deepEqual(view.reasonTexts, []);
	assert.deepEqual(view.warnings, [{ code: 'SMALL_BOUNDARY_CELLS', message: HOTSPOT.result.warnings[0].message,
		count: 24 }]);
	assert.equal(view.limitations.length, 5);
	assert.match(view.description, /Getis-Ord Gi\*/);

	const moran = view.moran;
	assert.deepEqual(moran.rows.map((r) => r.label), ['Moran\'s I', '기대값 E[I]', '순열 검정 p값 (양측)', '순열 횟수',
		'시뮬레이션 z']);
	assert.equal(moran.rows[0].value, '0.4815');
	assert.equal(moran.rows[1].value, api.formatNumber(-0.00625, 4));
	assert.equal(moran.rows[2].value, '0.001 (순열 999회에서 가능한 최솟값)');
	assert.equal(moran.rows[3].value, '999회');
	assert.equal(moran.rows[4].value, '11.48');
	assert.equal(moran.pAtMinimum, true);
	assert.match(moran.interpretation, /양의 공간 자기상관.*유의/);
	assert.match(moran.scope, /전체에 대한 하나의 값.*Gi\*/);
});

test('Moran\'s I wording follows only I, E[I] and p; missing values stay missing', () => {
	const withMoran = (moran, method) => okFor(50, (r) => {
		Object.assign(r.moran, moran);
		if (method) {
			Object.assign(r.method, method);
		}
	}).result;
	assert.match(hotspot.moranView(withMoran({ i: -0.2, expected: -0.00625, pValue: 0.02 }), api).interpretation,
		/음의 공간 자기상관/);
	assert.match(hotspot.moranView(withMoran({ pValue: 0.2 }), api).interpretation, /무작위 배치와 유의하게 다르다고 보기 어렵/);
	assert.match(hotspot.moranView(withMoran({ i: 0.3, pValue: 0.05 }), api).interpretation, /양의/);  // p ≤ 0.05
	const plain = hotspot.moranView(withMoran({ pValue: 0.0123, zSimulated: null }), api);
	assert.equal(plain.pAtMinimum, false);
	assert.equal(plain.rows[2].value, '0.012');
	assert.equal(plain.rows[4].value, '계산되지 않음');
	const noPermutations = hotspot.moranView(withMoran({}, { permutations: undefined }), api);
	assert.equal(noPermutations.rows[3].value, '-');
	assert.equal(noPermutations.rows[2].value, '0.001', 'no minimum note without the permutation count');
	// No Moran's I unless the status is OK and the three values are numbers.
	assert.equal(hotspot.moranView(withMoran({ i: null }), api), null);
	assert.equal(hotspot.moranView(withMoran({ pValue: 'x' }), api), null);
	assert.equal(hotspot.moranView(notTestedFor(50, 'CONSTANT_VALUES', 161).result, api), null);
	assert.equal(hotspot.moranView(okFor(50, (r) => { r.status = 'CONSTANT_VALUES'; }).result, api), null);
	// Probabilities keep their size.
	assert.deepEqual([0.5, 0.01, 0.0099, 0.001, 0.00123456, 0.0001, 0.00004321, null, NaN, '0.1']
		.map((p) => hotspot.formatProbability(p, api)),
	['0.500', '0.010', '0.0099', '0.001', '0.00123', '0.0001', '4.32e-5', '-', '-', '-']);
	// Class counts: a missing class is null and makes the total null.
	const counts = hotspot.classCounts({ classes: { HOT_99: 2, HOT_95: -1, HOT_90: 1.5 } });
	assert.deepEqual(counts.slice(0, 3).map((c) => c.count), [2, null, null]);
	assert.equal(hotspot.interpret(okFor(50, (r) => { delete r.summary.classes.HOT_95; }).result, api).hotCount, null);
	assert.equal(hotspot.interpret(okFor(50, (r) => { delete r.summary.classes.HOT_95; }).result, api).coldCount, 14);
});

test('PARTIAL_RESULT_BLOCKED: no counts, classes or Moran\'s I, the reasons and completeness are kept', () => {
	const view = hotspot.interpret(blockedFor(100).result, api);

	assert.equal(view.drawable, false);
	assert.match(view.message, /부분 조회 결과라 핫스팟과 Moran's I를 계산하지 않았습니다/);
	assert.equal(view.counts, null);
	assert.equal(view.classes, null);
	assert.equal(view.hotCount, null);
	assert.equal(view.coldCount, null);
	assert.equal(view.notTested, null);
	assert.equal(view.moran, null);
	assert.equal(view.complete, false);
	assert.equal(view.sourceComplete, false);
	assert.equal(view.pythonGeometryExcluded, null);
	assert.deepEqual(view.blockedReasons, ['PAGE_LIMIT']);
	assert.deepEqual(view.reasonTexts, ['조회 페이지 상한에 도달해 일부 건물만 조회했습니다.']);
	assert.equal(view.warnings[0].code, 'PARTIAL_RESULT_BLOCKED');

	const geometry = hotspot.interpret(blockedFor(100, { blockedReasons: ['PYTHON_GEOMETRY_EXCLUDED'], reasons: [],
		sourceComplete: true, excluded: 2 }).result, api);
	assert.equal(geometry.sourceComplete, true);
	assert.equal(geometry.pythonGeometryExcluded, 2);
	assert.deepEqual(geometry.reasonTexts, ['분석 서버가 복구할 수 없는 건물 도형이 2개 있어 전체 건물을 분석할 수 없습니다.']);
	const geometryUnknownCount = hotspot.interpret(blockedFor(100, { blockedReasons: ['PYTHON_GEOMETRY_EXCLUDED'],
		reasons: [], sourceComplete: true }).result, api);
	assert.deepEqual(geometryUnknownCount.reasonTexts, ['분석 서버가 복구할 수 없는 건물 도형이 있어 전체 건물을 분석할 수 없습니다.']);
	const several = hotspot.interpret(blockedFor(100, { blockedReasons: ['TOTAL_UNKNOWN', 'NEW_REASON'],
		reasons: [{ code: 'TOTAL_UNKNOWN', message: '전체 건수를 알 수 없습니다.' }] }).result, api);
	assert.deepEqual(several.reasonTexts, ['전체 건수를 알 수 없습니다.', '불완전 사유: NEW_REASON']);
});

test('CONSTANT_VALUES and INSUFFICIENT_CELLS: explained with the response numbers, nothing to draw', () => {
	const constant = hotspot.interpret(notTestedFor(100, 'CONSTANT_VALUES', 161).result, api);
	assert.equal(constant.drawable, false);
	assert.match(constant.message, /모든 셀의 점유율이 같아/);
	assert.equal(constant.moran, null);
	assert.equal(constant.classes, null);
	assert.deepEqual(constant.counts, { cellCount: 185, studyCellCount: 161, testedCellCount: 0, minTestedCells: 30 });
	assert.deepEqual(constant.notTested.map((n) => [n.reason, n.count]), [['SMALL_BOUNDARY', 24], ['CONSTANT_VALUES', 161]]);

	const few = hotspot.interpret(notTestedFor(100, 'INSUFFICIENT_CELLS', 12).result, api);
	assert.equal(few.drawable, false);
	assert.match(few.message, /검정할 수 있는 셀이 12개로 최소 30개보다 적어/);
	// Without the numbers in the response the sentence has none either.
	const missing = notTestedFor(100, 'INSUFFICIENT_CELLS', 12);
	delete missing.result.method.minTestedCells;
	assert.equal(hotspot.interpret(missing.result, api).message, hotspot.MESSAGES.INSUFFICIENT_CELLS);
});

test('cell detail: Gi* z, p and the corrected q for tested cells, the reason for untested ones', () => {
	const index = hotspot.indexCells(HOTSPOT.result);
	const hot = hotspot.cellDetail('2:2', index['2:2'], 50, api);
	assert.equal(hot.title, '셀 2:2 (50m)');
	assert.equal(hot.hotspotClass, 'HOT_99');
	assert.deepEqual(hot.rows.map((r) => r.label), ['분류', 'Gi* z점수', 'p값 (정규 근사, 보정 전)',
		'q값 (다중 검정 보정, 분류 기준)', '이웃 셀 수', '셀 점유율', '원 안 면적 비율', '위치']);
	assert.equal(hot.rows[0].value, '핫스팟 (신뢰수준 99%)');
	assert.equal(hot.rows[1].value, api.formatNumber(index['2:2'].giZ, 2));
	assert.equal(hot.rows[3].value, hotspot.formatProbability(index['2:2'].qValue, api));
	assert.match(hot.notes[0], /Benjamini-Hochberg/);

	const nsId = HOTSPOT.result.cells.features.find((f) => f.properties.hotspotClass === 'NOT_SIGNIFICANT').id;
	const ns = hotspot.cellDetail(nsId, index[nsId], 50, api);
	assert.ok(ns.notes.some((n) => /검정했지만.*유의하지 않습니다/.test(n)));

	const untested = hotspot.cellDetail('-3:-7', index['-3:-7'], 50, api);
	assert.deepEqual(untested.rows.map((r) => r.label), ['분류', '검정하지 않은 사유', '셀 점유율', '원 안 면적 비율', '위치']);
	assert.equal(untested.rows[0].value, '검정하지 않음');
	assert.equal(untested.rows[1].value, hotspot.REASON_LABELS.SMALL_BOUNDARY);
	assert.equal(untested.notes.length, 0);

	const empty = hotspot.cellDetail('9:9', { hotspotClass: 'COLD_90', giZ: null, pValue: null, qValue: null, col: 9, row: 9 },
		100, api);
	assert.deepEqual(empty.rows.slice(1, 6).map((r) => r.value), ['-', '-', '-', '-', '-']);
	assert.equal(hotspot.cellDetail('x', { hotspotClass: 'WHAT' }, 100, api).rows[0].value, '알 수 없음');
	// The class names match the map legend (NOT_TESTED is shortened; its reason is its own row).
	const legend = model.hotspotLegend();
	legend.slice(0, 7).forEach((item) => assert.equal(hotspot.CLASS_LABELS[item.key], item.label));
	assert.match(legend[7].label, /^검정하지 않음/);
	assert.deepEqual(hotspot.CLASSES, model.HOTSPOT_CLASSES);
});

/* ---------- controller: running and drawing ---------- */

test('run: only in the hotspot view with an analysis; snapshot and saved URLs; OK is drawn with hotspotStyle', async () => {
	const h = harness();
	h.controller.setService('available');
	assert.equal(h.controller.run(), false, 'no analysis');
	h.controller.setAnalysis(live(1));
	assert.equal(h.controller.run(), false, 'not in the hotspot view');
	assert.equal(h.calls.length, 0);

	h.controller.setView('hotspot');
	assert.equal(h.controller.run(), true);
	assert.deepEqual(h.calls.map((c) => c.url), ['/api/analysis-snapshots/' + TOKEN + '/hotspot?cellSize=100']);
	assert.equal(h.state().request.phase, 'loading');
	assert.deepEqual(h.order, [], 'nothing announced or hidden while loading');
	await h.answer('cellSize=100', ok(okFor(100)));
	assert.equal(h.state().drawing.phase, 'drawing');
	await h.drawAll();

	assert.equal(h.state().request.phase, 'done');
	assert.equal(h.state().display, true);
	assert.equal(h.state().drawing.phase, 'done');
	assert.equal(h.renderer.count(), 185);
	assert.equal(h.renders.length, 1);
	assert.equal(h.renders[0].options.styleFn, model.hotspotStyle);
	assert.deepEqual(h.order, ['layer:hotspot', 'buildings:false'], 'the grid is turned off before the buildings are hidden');
	assert.equal(h.state().outcome.status, 'OK');
	assert.deepEqual(h.state().prepared, { total: 185, invalid: 0, available: 185, shown: 185, truncated: 0, maxCells: 1345 });
	// Colors come from the class (hotspotStyle), not from the grid coverage colors.
	const byId = Object.fromEntries(HOTSPOT.result.cells.features.map((f) => [f.id, f.properties.hotspotClass]));
	h.created.forEach((obj, i) => assert.deepEqual(obj.color.rgba,
		model.HOTSPOT_COLORS[byId[h.renderer.getCells()[i].id]]));

	const s = harness();
	ready(s, saved(2, 12));
	s.controller.setCellSize(200);
	s.controller.run();
	assert.deepEqual(s.calls.map((c) => c.url), ['/api/analyses/12/hotspot?cellSize=200']);
});

test('blocked after an OK drawing: the old cells are removed, nothing is drawn, the reasons are kept', async () => {
	const h = harness();
	await shown(h, 50);
	assert.equal(h.renderer.count(), 185);
	h.order.length = 0;

	h.controller.setCellSize(100);
	assert.equal(h.renderer.count(), 0, 'cleared as soon as another size is requested');
	await h.answer('cellSize=100', ok(blockedFor(100)));
	await h.drawAll();

	assert.equal(h.renderer.count(), 0);
	assert.equal(h.renders.length, 1, 'no render call for the blocked answer');
	assert.equal(h.state().display, false);
	assert.equal(h.state().outcome.status, 'PARTIAL_RESULT_BLOCKED');
	assert.deepEqual(h.state().outcome.reasonTexts, ['조회 페이지 상한에 도달해 일부 건물만 조회했습니다.']);
	assert.equal(h.state().outcome.moran, null);
	assert.deepEqual(h.order, ['buildings:true']);
	assert.ok(h.created.every((obj) => obj.listenerRemoved));
	// A cached blocked answer also clears an OK drawing.
	h.controller.setCellSize(50);
	await h.drawAll();
	assert.equal(h.renderer.count(), 185);
	h.controller.setCellSize(100);
	await h.drawAll();
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().outcome.status, 'PARTIAL_RESULT_BLOCKED');
	assert.equal(h.calls.length, 2, 'both answers came from the cache');
});

test('CONSTANT_VALUES and INSUFFICIENT_CELLS are never drawn and clear an earlier drawing', async () => {
	for (const [status, study] of [['CONSTANT_VALUES', 161], ['INSUFFICIENT_CELLS', 12]]) {
		const h = harness();
		await shown(h, 50);
		h.controller.setCellSize(200);
		await h.answer('cellSize=200', ok(notTestedFor(200, status, study)));
		await h.drawAll();

		assert.equal(h.renderer.count(), 0, status);
		assert.equal(h.renders.length, 1, status);
		assert.equal(h.state().display, false);
		assert.equal(h.state().outcome.status, status);
		assert.equal(h.state().outcome.moran, null);
		assert.equal(h.state().selected, null);
		assert.equal(h.order[h.order.length - 1], 'buildings:true');
	}
});

test('a request in flight is not sent twice; a cached size is shown without a request', async () => {
	const h = harness();
	ready(h);
	h.controller.run();
	h.controller.run();
	h.controller.retry();  // not an error: nothing
	assert.equal(h.calls.length, 1);
	assert.equal(h.state().requestCount, 1);
	await h.answer('cellSize=100', ok(okFor(100)));
	await h.drawAll();
	h.controller.run();  // run again: from the cache
	await h.drawAll();
	assert.equal(h.calls.length, 1);
	assert.equal(h.renderer.count(), 185);
	assert.equal(h.renders.length, 2);
	assert.ok(h.renders.every((r) => r.options.styleFn === model.hotspotStyle));
});

test('cell sizes: invalid or unchanged sizes are ignored; before any result only the size changes', async () => {
	const h = harness();
	ready(h);
	for (const size of [75, '100', null, 100]) {
		h.controller.setCellSize(size);
	}
	assert.equal(h.state().cellSize, 100);
	h.controller.setCellSize(50);
	assert.equal(h.state().cellSize, 50);
	assert.equal(h.calls.length, 0, 'choosing a size before running requests nothing');
	h.controller.run();
	h.controller.setCellSize(200);  // while loading: the 50 m request is replaced
	assert.equal(h.calls[0].signal.aborted, true);
	assert.deepEqual(h.pending().map((c) => c.url), ['/api/analysis-snapshots/' + TOKEN + '/hotspot?cellSize=200']);
});

test('at most three cell sizes are cached, only for the current analysis', async () => {
	const h = harness();
	ready(h);
	for (const size of [50, 100, 200]) {
		h.controller.setCellSize(size);
		h.controller.run();
		await h.answer('cellSize=' + size, ok(okFor(size)));
		await h.drawAll();
	}
	assert.deepEqual(h.state().cache.map((e) => e.size), [50, 100, 200]);
	assert.equal(hotspot.MAX_CACHE, 3);
	for (const size of [50, 100, 200]) {
		h.controller.setCellSize(size);
		await h.drawAll();
	}
	assert.equal(h.calls.length, 3, 'every size from the cache');
	h.controller.setAnalysis(live(2, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
	assert.deepEqual(h.state().cache, []);
});

/* ---------- controller: analysis changes, saving, late answers ---------- */

test('a new analysis aborts the request, clears the cache, the cells and the result', async () => {
	const h = harness();
	await shown(h, 50);
	h.controller.setCellSize(100);
	const pending = h.pending()[0];
	h.order.length = 0;

	h.controller.setAnalysis(live(2, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
	assert.equal(pending.signal.aborted, true);
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().outcome, null);
	assert.deepEqual(h.state().cache, []);
	assert.equal(h.state().request.phase, 'idle');
	assert.equal(h.state().targetKey, '2:token:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	// The same analysis again changes nothing.
	const before = h.changes();
	h.controller.setAnalysis(live(2, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
	assert.equal(h.state().targetKey, '2:token:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	assert.equal(h.changes(), before + 1);
	// Reset (no analysis): nothing can run.
	h.controller.setAnalysis(null);
	assert.equal(h.controller.run(), false);
});

test('saving switches to the analysis id: drawing and cache kept, a loading request is sent again by id', async () => {
	const h = harness();
	await shown(h, 50);
	h.controller.analysisSaved({ generation: 1, analysisId: 77 });
	assert.equal(h.state().targetKey, '1:id:77');
	assert.equal(h.renderer.count(), 185);
	assert.equal(h.state().cache.length, 1);
	assert.equal(h.state().request.key, '1:id:77:50');
	// Other generations or a saved analysis are ignored.
	h.controller.analysisSaved({ generation: 9, analysisId: 78 });
	h.controller.analysisSaved({ generation: 1, analysisId: 79 });
	assert.equal(h.state().targetKey, '1:id:77');

	const l = harness();
	ready(l);
	l.controller.run();
	const snapshotCall = l.calls[0];
	l.controller.analysisSaved({ generation: 1, analysisId: 77 });
	assert.equal(snapshotCall.signal.aborted, true);
	assert.deepEqual(l.pending().map((c) => c.url), ['/api/analyses/77/hotspot?cellSize=100']);
	await l.answer('/analyses/77/', ok(okFor(100)));
	await l.drawAll();
	assert.equal(l.renderer.count(), 185);
});

test('late answers for an old size, an old analysis or after leaving the view are ignored', async () => {
	const h = harness({ ignoreAbort: true });
	ready(h);
	h.controller.setCellSize(50);
	h.controller.run();
	h.controller.setCellSize(200);
	await h.answer('cellSize=50', ok(okFor(50)));  // the replaced 50 m answer arrives late
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().cache.length, 0);
	await h.answer('cellSize=200', ok(okFor(200)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 185);

	const a = harness({ ignoreAbort: true });
	ready(a);
	a.controller.run();
	a.controller.setAnalysis(live(2, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
	await a.answer('cellSize=100', ok(okFor(100)));
	await a.drawAll();
	assert.equal(a.renderer.count(), 0);
	assert.equal(a.state().outcome, null);
	assert.deepEqual(a.order, []);

	const v = harness({ ignoreAbort: true });
	ready(v);
	v.controller.run();
	v.controller.setView('grid');
	await v.answer('cellSize=100', ok(blockedFor(100)));
	await v.drawAll();
	assert.equal(v.state().outcome, null, 'a late blocked answer does not show up in another view');
	assert.equal(v.renderer.count(), 0);
});

/* ---------- controller: views, errors, layers, map events ---------- */

test('leaving the hotspot view cancels the request and clears the cells; the cache is kept', async () => {
	const h = harness();
	await shown(h, 50);
	h.controller.setCellSize(100);
	const pending = h.pending()[0];
	h.controller.setCellSize(50);  // back to the drawn size (cache)
	await h.drawAll();
	assert.equal(pending.signal.aborted, true);
	assert.equal(h.renderer.count(), 185);
	h.order.length = 0;

	h.controller.setView('stats');
	assert.equal(h.state().active, false);
	assert.equal(h.renderer.count(), 0);
	assert.ok(h.created.every((obj) => obj.listenerRemoved));
	assert.equal(h.state().outcome, null);
	assert.deepEqual(h.order, ['buildings:true']);
	assert.equal(h.controller.run(), false, 'not in the hotspot view');

	h.controller.setView('hotspot');
	h.controller.run();
	await h.drawAll();
	assert.equal(h.renderer.count(), 185);
	assert.equal(h.calls.length, 2, 'drawn again from the cache');
	// The same view again keeps everything.
	h.controller.setView('hotspot');
	assert.equal(h.renderer.count(), 185);

	const loading = harness();
	ready(loading);
	loading.controller.run();
	loading.controller.setView('compare');
	assert.equal(loading.calls[0].signal.aborted, true);
	assert.equal(loading.state().request.phase, 'idle');
});

test('errors: messages from describeError, retry, integrity errors, expired snapshots and a broken target', async () => {
	const h = harness();
	ready(h);
	h.controller.run();
	await h.answer('cellSize=100', { ok: false, status: 503, body: { error: 'ANALYSIS_SERVICE_BUSY' } });
	assert.equal(h.state().request.phase, 'error');
	assert.equal(h.state().request.error.message, api.MESSAGES.ANALYSIS_SERVICE_BUSY);
	assert.equal(h.state().request.error.retryable, true);
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.controller.retry(), true);
	await h.answer('cellSize=100', ok(okFor(100)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 185);

	const down = harness();
	ready(down);
	down.controller.run();
	await down.answer('cellSize=100', { ok: false, status: 503, body: { error: 'ANALYSIS_SERVICE_UNAVAILABLE' } });
	assert.equal(down.statusRefreshes(), 1);

	const expired = harness();
	ready(expired);
	expired.controller.run();
	await expired.answer('cellSize=100', { ok: false, status: 410, body: { error: 'SNAPSHOT_EXPIRED' } });
	assert.equal(expired.state().request.error.code, 'SNAPSHOT_EXPIRED');
	assert.equal(expired.state().request.error.retryable, false);

	const broken = harness();
	ready(broken);
	broken.controller.run();
	await broken.answer('cellSize=100', ok(okFor(100, (r) => { r.summary.cellCount = 1; })));
	assert.equal(broken.state().request.error.code, 'HOTSPOT_INTEGRITY');
	assert.equal(broken.state().request.error.retryable, true);
	assert.equal(broken.renderer.count(), 0);
	assert.equal(broken.state().cache.length, 0, 'a broken answer is not cached');

	const network = harness();
	ready(network);
	network.controller.run();
	await network.answer('cellSize=100', { ok: false, network: true, aborted: false });
	assert.equal(network.state().request.error.code, 'NETWORK');

	const noToken = harness();
	ready(noToken, { generation: 1, source: 'live', analysisToken: null });
	noToken.controller.run();
	assert.equal(noToken.calls.length, 0);
	assert.equal(noToken.state().request.error.code, 'INVALID_TOKEN');
});

test('python not available: nothing is requested until the service is back', () => {
	const h = harness();
	h.controller.setAnalysis(live(1));
	h.controller.setView('hotspot');
	for (const service of ['unavailable', 'not-configured']) {
		h.controller.setService(service);
		assert.equal(h.controller.run(), false);
		assert.equal(h.state().request.phase, 'blocked');
	}
	assert.equal(h.calls.length, 0);
	h.controller.setService('available');
	assert.equal(h.state().request.phase, 'idle');
	assert.equal(h.controller.run(), true);
	assert.equal(h.calls.length, 1);
});

test('the grid layer turns the hotspot off without a new event; its own and unknown layers are ignored', async () => {
	const h = harness();
	await shown(h, 50);
	h.order.length = 0;
	for (const layer of ['hotspot', undefined, null, 'GRID', 'other']) {
		h.controller.layerChanged(layer);
	}
	assert.equal(h.renderer.count(), 185);
	assert.deepEqual(h.order, []);

	h.controller.layerChanged('grid');
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().display, false);
	assert.equal(h.state().outcome, null);
	assert.deepEqual(h.order, ['buildings:true'], 'no layer event sent back');
	// While loading the request is aborted.
	h.controller.setCellSize(200);
	h.controller.run();
	const pending = h.pending()[0];
	h.controller.layerChanged('grid');
	assert.equal(pending.signal.aborted, true);
	// Nothing on the map and nothing shown: the grid event changes nothing.
	const before = h.changes();
	h.controller.layerChanged('grid');
	assert.equal(h.changes(), before);
});

test('"clear" removes the cells and the result, keeps the cache', async () => {
	const h = harness();
	await shown(h, 50);
	h.controller.clear();
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().outcome, null);
	assert.equal(h.state().display, false);
	assert.equal(h.state().cache.length, 1);
	h.controller.run();
	await h.drawAll();
	assert.equal(h.calls.length, 1);
	assert.equal(h.renderer.count(), 185);
});

test('measurement reset redraws only while the hotspot is on, with the same colors', async () => {
	const h = harness();
	ready(h);
	assert.equal(h.controller.measureReset(), false);
	await shown(h, 50);
	const colors = h.created.map((obj) => obj.color.rgba.join(','));
	assert.equal(h.controller.measureReset(), true);
	await h.drawAll();
	assert.equal(h.renderer.count(), 185);
	assert.deepEqual(h.created.slice(185).map((obj) => obj.color.rgba.join(',')), colors);
	assert.equal(h.renders.length, 1, 'restore, not a new render');
	assert.equal(h.clearCalls(), 0, 'map.clear() is never called');

	h.controller.setCellSize(100);
	await h.answer('cellSize=100', ok(blockedFor(100)));
	assert.equal(h.controller.measureReset(), false, 'nothing to restore after a blocked answer');
});

test('cell click: ignored while measuring or when off; otherwise the detail, no new radius center', async () => {
	const h = harness();
	await shown(h, 50);
	const index = h.renderer.getCells().findIndex((c) => c.id === '2:2');
	h.setMode('distance');
	h.created[index].listener();
	assert.equal(h.state().selected, null);
	assert.equal(h.suppressed(), 0);
	h.setMode('select');
	h.created[index].listener();
	assert.equal(h.state().selected.title, '셀 2:2 (50m)');
	assert.equal(h.state().selected.hotspotClass, 'HOT_99');
	assert.equal(h.suppressed(), 1);
	assert.equal(h.opened(), 1);
	assert.equal(h.controller.pick('no-such-cell'), false);
	h.controller.clear();
	assert.equal(h.controller.pick('2:2'), false);
	assert.equal(h.suppressed(), 2);
});

/* ---------- grid and hotspot together ---------- */

test('grid and hotspot controllers on one map: never both drawn, buildings hidden exactly while one is on', async () => {
	const fake = fakeMap();
	const gridRenderer = model.createRenderer(fake.env);
	gridRenderer.setMap(fake.map);
	const { renderer: hotspotRenderer } = recordingRenderer(fake);
	let buildingsVisible = true;
	const sequence = [];
	const calls = [];
	const controllers = {};
	function dispatch(layer) {
		sequence.push('event:' + layer);
		controllers.grid.layerChanged(layer);
		controllers.hotspot.layerChanged(layer);
	}
	const analysisRenderer = () => ({ setBuildingsVisible: (v) => { buildingsVisible = v; sequence.push('buildings:' + v); } });
	controllers.grid = gridView.createController({ api, model, renderer: gridRenderer, analysisRenderer,
		analysis: () => null, mode: () => 'select', fetchJson: fakeFetch(calls), base: '/api', online: () => true,
		dispatchLayer: dispatch });
	controllers.hotspot = hotspot.createController({ api, model, renderer: hotspotRenderer, analysisRenderer,
		analysis: () => null, mode: () => 'select', fetchJson: fakeFetch(calls), base: '/api', online: () => true,
		dispatchLayer: dispatch });
	async function answer(fragment, body) {
		const call = calls.find((c) => !c.answered && c.url.includes(fragment));
		call.answered = true;
		call.resolve(ok(body));
		await flush();
		await fake.drawAll();
	}
	const gridBody = clone(GRID);
	gridBody.result.cellSizeMeters = 100;
	for (const c of Object.values(controllers)) {
		c.setService('available');
		c.setAnalysis(live(1));
	}

	// 1. grid on (it stays on in other views)
	controllers.grid.setDisplay(true);
	await answer('/grid-density', gridBody);
	assert.equal(gridRenderer.count(), 8);
	assert.equal(buildingsVisible, false);

	// 2. hotspot run in its view: the grid goes off first, then the hotspot hides the buildings
	controllers.hotspot.setView('hotspot');
	sequence.length = 0;
	controllers.hotspot.run();
	assert.equal(gridRenderer.count(), 8, 'the grid stays until the hotspot has something to draw');
	await answer('/hotspot', okFor(100));
	assert.equal(gridRenderer.count(), 0);
	assert.equal(hotspotRenderer.count(), 185);
	assert.equal(controllers.grid.getState().display, false);
	assert.equal(buildingsVisible, false);
	assert.deepEqual(sequence, ['event:hotspot', 'buildings:true', 'buildings:false']);

	// 3. grid on again: the hotspot goes off, the grid draws from its cache
	sequence.length = 0;
	controllers.grid.setDisplay(true);
	await fake.drawAll();
	assert.equal(hotspotRenderer.count(), 0);
	assert.equal(gridRenderer.count(), 8);
	assert.equal(buildingsVisible, false);
	assert.deepEqual(sequence, ['event:grid', 'buildings:true', 'buildings:false']);

	// 4. a blocked hotspot answer does not turn the grid off (nothing to draw)
	controllers.hotspot.setCellSize(200);
	controllers.hotspot.run();
	await answer('cellSize=200', blockedFor(200));
	assert.equal(gridRenderer.count(), 8);
	assert.equal(hotspotRenderer.count(), 0);
	assert.equal(buildingsVisible, false);

	// 5. grid off: buildings back, nothing on the map
	controllers.grid.setDisplay(false);
	assert.equal(gridRenderer.count(), 0);
	assert.equal(buildingsVisible, true);
	assert.equal(fake.clearCalls(), 0);
});

/* ---------- browser connection (the panel itself: spatial-hotspot-dom.test.js) ---------- */

function browserPage() {
	const listeners = [];
	const fake = fakeMap();
	const document = {
		currentScript: null,
		getElementById: () => null,  // a page without the hotspot panel
		addEventListener: (type, fn) => listeners.push({ type, fn }),
		removeEventListener: (type, fn) => {
			const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
			if (i >= 0) {
				listeners.splice(i, 1);
			}
		},
		dispatchEvent: (event) => listeners.filter((l) => l.type === event.type).forEach((l) => l.fn(event))
	};
	const window = {
		document, vw: fake.env.vw(), console: { warn() {} }, CustomEvent: class { constructor(type, init) {
			this.type = type;
			this.detail = init && init.detail;
		} },
		requestAnimationFrame: () => 1, cancelAnimationFrame() {}, navigator: { onLine: true },
		gisAnalysis: { getCurrent: () => live(1) },
		gisSpatialViews: { current: () => 'stats' }
	};
	window.window = window;
	const context = vm.createContext(window);
	for (const file of ['spatial-api.js', 'spatial-grid-renderer.js', 'spatial-hotspot.js']) {
		vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
	}
	return { window, document, listeners, fake };
}

test('without the hotspot panel the script creates no renderer and no listeners', () => {
	const p = browserPage();
	assert.equal(p.window.gisSpatialHotspot, undefined);
	assert.equal(p.listeners.filter((l) => l.type === 'gis:mapready').length, 1, 'only the grid renderer');
	assert.equal(hotspot.start(p.document, p.window), null);
	assert.equal(p.listeners.length, 1);
});

test('connect: one hotspot renderer per page, separate from gisGridRenderer, events connected once', () => {
	const p = browserPage();
	const first = hotspot.connect(p.document, p.window);
	assert.equal(p.window.gisSpatialHotspot, first);
	assert.deepEqual(Object.keys(first).sort(), ['clear', 'getState', 'retry', 'run', 'setCellSize']);
	assert.equal(p.listeners.filter((l) => l.type === 'gis:mapready').length, 2, 'grid renderer + hotspot renderer');
	const count = p.listeners.length;
	assert.equal(hotspot.connect(p.document, p.window), first, 'a second call returns the same instance');
	assert.equal(p.listeners.length, count, 'no second renderer, no second set of listeners');
	for (const type of ['gis:analysisresult', 'gis:analysissaved', 'gis:spatialstatus', 'gis:measurereset',
		'gis:spatialviewchange', 'gis:spatiallayerchange']) {
		assert.equal(p.listeners.filter((l) => l.type === type).length, 1, type);
	}
	// The current analysis and view were read at start.
	assert.equal(first.getState().targetKey, '1:token:' + TOKEN);
	assert.equal(first.getState().active, false);
	p.document.dispatchEvent(new p.window.CustomEvent('gis:spatialviewchange', { detail: { view: 'hotspot' } }));
	assert.equal(first.getState().active, true);
	p.document.dispatchEvent(new p.window.CustomEvent('gis:analysisresult', { detail: saved(2, 5) }));
	assert.equal(first.getState().targetKey, '2:id:5');
	// Without the renderer model nothing is connected.
	const bare = { gisSpatialApi: api };
	assert.equal(hotspot.connect(p.document, bare), null);
	assert.equal(bare.gisSpatialHotspot, undefined);
});

test('status texts carry a word label, not only a color', () => {
	const base = { request: { phase: 'idle' }, drawing: { phase: 'none' }, outcome: null };
	const info = (change) => hotspot.statusInfo({ ...base, ...change }, api);
	assert.equal(info({}), null);
	assert.deepEqual([info({ request: { phase: 'loading', size: 50 } }).label, info({ request: { phase: 'loading', size: 50 } }).text],
		['분석 중', '격자 핫스팟을 계산하고 있습니다... (셀 50m)']);
	assert.equal(info({ request: { phase: 'error', error: { message: 'm' } } }).label, '오류');
	assert.equal(info({ request: { phase: 'blocked' } }).label, '사용 불가');
	assert.equal(info({ drawing: { phase: 'drawing', created: 100, total: 185 } }).text,
		'지도에 핫스팟 격자를 그리고 있습니다... (100 / 185)');
	assert.equal(info({ drawing: { phase: 'failed' } }).kind, 'error');
	assert.equal(info({ drawing: { phase: 'done', errors: 2 } }).label, '주의');
	const blocked = hotspot.interpret(blockedFor(100).result, api);
	assert.deepEqual([info({ outcome: blocked }).label, info({ outcome: blocked }).text], ['부분 결과 차단', blocked.message]);
	const constant = hotspot.interpret(notTestedFor(100, 'CONSTANT_VALUES', 161).result, api);
	assert.equal(info({ outcome: constant }).label, '분석 불가');
	assert.equal(info({ outcome: hotspot.interpret(HOTSPOT.result, api) }), null);
});

test('notice box and summary cards use only the response values', () => {
	const ok = hotspot.interpret(HOTSPOT.result, api);
	assert.equal(hotspot.noticeBox(ok, api), null);
	assert.equal(hotspot.noticeBox(null, api), null);
	assert.deepEqual(hotspot.summaryCards(ok, api).map((c) => [c.label, c.value]),
		[['핫스팟 셀', '15개'], ['콜드스팟 셀', '14개'], ['검정한 셀', '161개'], ['전체 셀', '185개']]);

	const blocked = hotspot.noticeBox(hotspot.interpret(blockedFor(100).result, api), api);
	assert.match(blocked.title, /부분 조회 결과/);
	assert.deepEqual(blocked.lines, ['조회 페이지 상한에 도달해 일부 건물만 조회했습니다.']);
	assert.deepEqual(blocked.rows.map((r) => r.value), ['부분 조회', '불완전 (분석 차단)', '확인 전에 차단']);
	const geometry = hotspot.noticeBox(hotspot.interpret(blockedFor(100, { blockedReasons: ['PYTHON_GEOMETRY_EXCLUDED'],
		reasons: [], sourceComplete: true, excluded: 3 }).result, api), api);
	assert.deepEqual(geometry.rows.map((r) => r.value), ['전체 조회', '불완전 (분석 차단)', '3개']);
	assert.deepEqual(hotspot.summaryCards(hotspot.interpret(blockedFor(100).result, api), api), []);

	const few = hotspot.noticeBox(hotspot.interpret(notTestedFor(100, 'INSUFFICIENT_CELLS', 12).result, api), api);
	assert.deepEqual(few.rows.map((r) => r.value), ['185개', '12개', '30개']);
	assert.deepEqual(few.lines, [hotspot.REASON_LABELS.SMALL_BOUNDARY + ': 24개',
		hotspot.REASON_LABELS.INSUFFICIENT_CELLS + ': 161개']);
	assert.deepEqual(hotspot.summaryCards(hotspot.interpret(notTestedFor(100, 'INSUFFICIENT_CELLS', 12).result, api), api), []);
});
