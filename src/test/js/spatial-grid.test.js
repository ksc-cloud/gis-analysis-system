// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The grid view controller with the real spatial-grid-renderer.js on a fake VWorld map. Real VWorld behaviour is
// checked in the browser (8-6B-2d).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const JS = path.join(__dirname, '../../main/resources/static/js');
const api = require(path.join(JS, 'spatial-api.js'));
const model = require(path.join(JS, 'spatial-grid-renderer.js'));
const gridView = require(path.join(JS, 'spatial-grid.js'));
const GRID = require('./fixtures/grid-density-100m-50.json');  // real response: 21 cells, 13 empty, cellSize 50

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The fixture as the answer for another cell size (only the size field changes). */
function gridFor(size, change) {
	const body = JSON.parse(JSON.stringify(GRID));
	body.result.cellSizeMeters = size;
	if (change) {
		change(body.result);
	}
	return body;
}

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

function harness(options = {}) {
	// fake VWorld map for the real renderer
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
			this.listenerRemoved = true;
		}
	}
	const vw = { geom: { PolygonZ }, Collection: class { constructor(i) { this.items = i; } },
		Coord: class { constructor(x, y) { this.x = x; this.y = y; } }, Color: class {} };
	let clearCalls = 0;
	const map = { removeObject: (o) => removed.push(o), clear: () => clearCalls++ };
	const frames = [];
	const renderer = model.createRenderer({
		vw: () => vw,
		raf: (cb) => frames.push(cb),
		cancelRaf: (id) => {
			frames[id - 1] = null;
		}
	});
	renderer.setMap(map);
	async function drawAll() {
		for (let guard = 0; guard < 100 && frames.some(Boolean); guard++) {
			frames.splice(0, frames.length).forEach((cb) => cb && cb(0));
			await flush();
		}
		await flush();
	}

	// fake Java API: answers wait for the test
	const calls = [];
	const buildingsVisible = [];
	let suppressed = 0;
	let mode = options.mode || 'select';
	let statusRefreshes = 0;
	let opened = 0;
	const controller = gridView.createController({
		api,
		model,
		renderer,
		analysisRenderer: () => ({ setBuildingsVisible: (v) => buildingsVisible.push(v) }),
		analysis: () => ({ suppressNextMapClick: () => suppressed++ }),
		mode: () => mode,
		fetchJson(url, signal) {
			return new Promise((resolve) => {
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
		},
		base: '/api',
		online: () => true,
		render: () => {},
		refreshStatus: () => statusRefreshes++,
		openGridView: () => opened++
	});
	renderer.setPickHandler(controller.pick);  // what start() does in the browser
	async function answer(fragment, res) {
		const call = calls.find((c) => !c.answered && c.url.includes(fragment));
		assert.ok(call, 'no pending request for ' + fragment);
		call.answered = true;
		call.resolve(res);
		await flush();
	}
	return {
		controller, renderer, calls, created, removed, frames, drawAll, answer, buildingsVisible,
		state: () => controller.getState(),
		suppressed: () => suppressed,
		opened: () => opened,
		statusRefreshes: () => statusRefreshes,
		setMode: (m) => {
			mode = m;
		},
		clearCalls: () => clearCalls,
		gridCalls: () => calls.filter((c) => c.url.includes('/grid-density'))
	};
}

const ok = (body) => ({ ok: true, status: 200, body });
const live = (generation, token = TOKEN) => ({ generation, source: 'live', analysisToken: token, radius: 100 });
const saved = (generation, analysisId) => ({ generation, source: 'saved', analysisId, radius: 100 });

async function shown(h, detail = live(1), size = 100) {
	h.controller.setService('available');
	h.controller.setAnalysis(detail);
	h.controller.setDisplay(true);
	await h.answer('cellSize=' + size, ok(gridFor(size)));
	await h.drawAll();
}

/* ---------- pure ---------- */

test('response checks: structure, features count and cell size', () => {
	assert.equal(gridView.validateResponse(GRID, 50).ok, true);
	assert.equal(gridView.validateResponse(GRID, 100).reason, 'cellSize');
	assert.equal(gridView.validateResponse(gridFor(50, (r) => { r.grid.returnedCellCount = 22; }), 50).reason, 'count');
	assert.equal(gridView.validateResponse(gridFor(50, (r) => { r.cells.features.pop(); }), 50).reason, 'count');
	for (const body of [null, {}, { result: {} }, { result: { cells: { type: 'Feature', features: [] }, grid: {} } },
		{ result: { cells: { type: 'FeatureCollection', features: [] } } }]) {
		assert.equal(gridView.validateResponse(body, 50).ok, false);
	}
});

test('cell detail and notices are plain text built from numbers', () => {
	const index = gridView.indexCells(GRID.result);
	const detail = gridView.cellDetail('0:0', index['0:0'], 50, api);
	assert.equal(detail.title, '셀 0:0 (50m)');
	assert.deepEqual(detail.rows.map((r) => r.label), ['셀 점유율', '건물 점유 면적', '셀에 걸친 건물', '대표 건물', '원 안 면적', '위치']);
	assert.equal(detail.rows[0].value, '64.00%');
	assert.equal(detail.notes.length, 0);
	assert.match(gridView.cellDetail('-1:-2', index['-1:-2'], 50, api).notes[0], /25% 미만/);

	const prepared = { invalid: 2, truncated: 155, maxCells: 1345, shown: 1345, emptyExcluded: 0, total: 1502 };
	const list = gridView.notices(prepared, { completeness: { complete: false } }, api);
	assert.match(list[0], /올바르지 않은 셀 2개/);
	assert.match(list[1], /상한\(1,345개\).*155개/);
	assert.match(list[2], /부분 조회 결과/);
	assert.match(gridView.notices({ invalid: 0, truncated: 0, shown: 0, emptyExcluded: 13 }, {}, api)[0], /빈 격자 숨기기/);
	assert.equal(gridView.summaryText({ shown: 8, total: 21, emptyExcluded: 13 }, 50, api), '셀 50m · 표시 8개 / 전체 21개 · 빈 격자 13개 숨김');
});

/* ---------- display ---------- */

test('turning the grid on requests 100 m cells, hides analysis buildings and draws non-empty cells', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	assert.equal(h.calls.length, 0);  // nothing until the grid is turned on

	assert.equal(h.controller.setDisplay(true), true);
	assert.deepEqual(h.buildingsVisible, [false]);
	assert.deepEqual(h.gridCalls().map((c) => c.url),
		['/api/analysis-snapshots/' + TOKEN + '/grid-density?cellSize=100&includeEmptyCells=true&includeBuildingIds=false']);
	assert.equal(h.state().request.phase, 'loading');
	await h.answer('cellSize=100', ok(gridFor(100)));
	assert.equal(h.state().drawing.phase, 'drawing');
	await h.drawAll();

	assert.equal(h.state().drawing.phase, 'done');
	assert.equal(h.state().drawing.created, 8);
	assert.equal(h.renderer.count(), 8);
	assert.deepEqual(h.state().prepared, { total: 21, invalid: 0, emptyExcluded: 13, available: 8, shown: 8, truncated: 0,
		maxCells: 1345 });
});

test('turning the grid off removes cells and listeners and shows the buildings again', async () => {
	const h = harness();
	await shown(h);
	h.controller.setDisplay(false);

	assert.equal(h.renderer.count(), 0);
	assert.ok(h.created.every((o) => h.removed.includes(o) && o.listenerRemoved));
	assert.deepEqual(h.buildingsVisible, [false, true]);
	assert.equal(h.state().display, false);
	assert.equal(h.clearCalls(), 0);
	// Turning it on again uses the cached answer: no new request.
	h.controller.setDisplay(true);
	await h.drawAll();
	assert.equal(h.gridCalls().length, 1);
	assert.equal(h.renderer.count(), 8);
});

test('cell size change: new request, previous cells removed first, cache reused afterwards', async () => {
	const h = harness();
	await shown(h);
	const first = h.created.slice();
	h.controller.setCellSize(50);

	assert.ok(first.every((o) => h.removed.includes(o)));  // removed before the new answer arrives
	assert.equal(h.renderer.count(), 0);
	assert.match(h.gridCalls()[1].url, /cellSize=50/);
	await h.answer('cellSize=50', ok(gridFor(50)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);

	h.controller.setCellSize(100);  // cached
	await h.drawAll();
	assert.equal(h.gridCalls().length, 2);
	assert.equal(h.state().cellSize, 100);
	h.controller.setCellSize(75);   // not allowed
	assert.equal(h.state().cellSize, 100);
});

test('at most three cell sizes are cached, only for the current analysis', async () => {
	const h = harness();
	await shown(h);
	for (const size of [50, 200]) {
		h.controller.setCellSize(size);
		await h.answer('cellSize=' + size, ok(gridFor(size)));
		await h.drawAll();
	}
	assert.deepEqual(h.state().cache.map((c) => c.size), [100, 50, 200]);
	h.controller.setAnalysis(live(2, 'bbbbbbbb-0000-0000-0000-000000000002'));
	assert.deepEqual(h.state().cache, []);
});

test('empty-cell toggle redraws from the cached answer without a request', async () => {
	const h = harness();
	await shown(h);
	h.controller.setExcludeEmpty(false);
	await h.drawAll();

	assert.equal(h.renderer.count(), 21);
	assert.equal(h.gridCalls().length, 1);
	h.controller.setExcludeEmpty(true);
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);
});

/* ---------- requests ---------- */

test('the same analysis and cell size is requested only once', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	h.controller.setDisplay(true);
	h.controller.setCellSize(100);
	h.controller.setAnalysis(live(1));
	assert.equal(h.gridCalls().length, 1);
	assert.equal(h.state().requestCount, 1);
});

test('a late answer for an old cell size or an old analysis is ignored', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	h.controller.setCellSize(50);
	await h.answer('cellSize=100', ok(gridFor(100)));  // arrives after the switch to 50 m
	await h.drawAll();
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().request.size, 50);
	assert.equal(h.state().request.phase, 'loading');  // the 50 m request is still the one in flight
	assert.deepEqual(h.state().cache, []);              // and the late answer was not cached
	await h.answer('cellSize=50', ok(gridFor(50)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);

	h.controller.setDisplay(false);
	h.controller.setDisplay(true);  // cached 50 m, no request
	h.controller.setCellSize(200);
	h.controller.setAnalysis(saved(5, 12));  // another analysis while 200 m is loading
	await h.answer('cellSize=200', ok(gridFor(200)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().display, false);
	assert.deepEqual(h.state().cache, []);  // the old analysis's answer is not kept for the new analysis
	assert.equal(h.state().request.phase, 'idle');
});

test('a request in flight is aborted when the analysis changes or the grid is turned off', () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	const first = h.gridCalls()[0];
	h.controller.setDisplay(false);
	assert.equal(first.signal.aborted, true);
	h.controller.setDisplay(true);
	const second = h.gridCalls()[1];
	h.controller.setAnalysis({ generation: 2, source: null });
	assert.equal(second.signal.aborted, true);
	assert.equal(h.state().target, null);
});

test('saving switches to the analysis id: drawn grid and cache kept, loading request re-sent by id', async () => {
	const h = harness();
	await shown(h, live(4));
	h.controller.analysisSaved({ generation: 4, analysisId: 21 });

	assert.equal(h.renderer.count(), 8);
	assert.equal(h.state().target.kind, 'saved');
	h.controller.setCellSize(50);
	assert.equal(h.gridCalls()[1].url, '/api/analyses/21/grid-density?cellSize=50&includeEmptyCells=true&includeBuildingIds=false');
	h.controller.analysisSaved({ generation: 4, analysisId: 21 });  // already saved: nothing happens
	assert.equal(h.gridCalls().length, 2);

	const h2 = harness();
	h2.controller.setService('available');
	h2.controller.setAnalysis(live(4));
	h2.controller.setDisplay(true);
	const snapshotCall = h2.gridCalls()[0];
	h2.controller.analysisSaved({ generation: 4, analysisId: 21 });
	assert.equal(snapshotCall.signal.aborted, true);
	assert.match(h2.gridCalls()[1].url, /^\/api\/analyses\/21\/grid-density\?cellSize=100/);
	await h2.answer('/analyses/21/', ok(gridFor(100)));
	await h2.drawAll();
	assert.equal(h2.renderer.count(), 8);
	assert.ok(!h2.gridCalls().slice(1).some((c) => c.url.includes(TOKEN)));
});

test('a new analysis clears the grid, the cache and turns the display off', async () => {
	const h = harness();
	await shown(h);
	h.controller.setAnalysis(saved(9, 30));

	assert.equal(h.renderer.count(), 0);
	assert.equal(h.state().display, false);
	assert.deepEqual(h.state().cache, []);
	assert.deepEqual(h.buildingsVisible, [false, true]);
	assert.equal(h.state().target.analysisId, 30);
});

/* ---------- errors ---------- */

for (const [status, code] of [[410, 'SNAPSHOT_EXPIRED'], [503, 'ANALYSIS_SERVICE_UNAVAILABLE'],
	[503, 'ANALYSIS_SERVICE_NOT_CONFIGURED'], [503, 'ANALYSIS_SERVICE_BUSY'], [504, 'ANALYSIS_SERVICE_TIMEOUT'],
	[422, 'ANALYSIS_DATA_UNSUPPORTED']]) {
	test('error ' + status + ' ' + code + ': message, display off, buildings back', async () => {
		const h = harness();
		h.controller.setService('available');
		h.controller.setAnalysis(live(1));
		h.controller.setDisplay(true);
		await h.answer('cellSize=100', { ok: false, status, body: { error: code, message: 'server text' } });

		assert.equal(h.state().request.phase, 'error');
		assert.equal(h.state().request.error.code, code);
		assert.equal(h.state().request.error.message, api.MESSAGES[code]);
		assert.equal(h.state().display, false);
		assert.deepEqual(h.buildingsVisible, [false, true]);
		assert.equal(h.renderer.count(), 0);
		assert.equal(h.statusRefreshes(), code === 'ANALYSIS_SERVICE_UNAVAILABLE' || code === 'ANALYSIS_SERVICE_NOT_CONFIGURED' ? 1 : 0);
	});
}

test('integrity errors (count or size mismatch) are not drawn and can be retried', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	await h.answer('cellSize=100', ok(gridFor(100, (r) => { r.grid.returnedCellCount = 99; })));

	assert.equal(h.state().request.error.code, 'GRID_INTEGRITY');
	assert.equal(h.state().request.error.retryable, true);
	assert.equal(h.renderer.count(), 0);
	h.controller.retry();
	await h.answer('cellSize=100', ok(gridFor(100)));
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);
});

test('invalid and truncated cells are reported', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	await h.answer('cellSize=100', ok(gridFor(100, (r) => {
		r.cells.features[3].properties.coverageRatio = 'x';
		r.completeness.complete = false;
	})));
	await h.drawAll();

	assert.equal(h.state().prepared.invalid, 1);
	assert.match(h.state().notices.join(' '), /올바르지 않은 셀 1개/);
	assert.match(h.state().notices.join(' '), /부분 조회 결과/);
});

test('python unavailable: the grid cannot be turned on, no request', () => {
	const h = harness();
	h.controller.setAnalysis(live(1));
	for (const state of ['unavailable', 'not-configured']) {
		h.controller.setService(state);
		assert.equal(h.controller.setDisplay(true), false);
		assert.equal(h.state().request.phase, 'blocked');
	}
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.buildingsVisible, []);
	h.controller.setService('available');
	assert.equal(h.state().request.phase, 'idle');
	assert.equal(h.controller.setDisplay(true), true);
});

test('without an analysis the grid cannot be turned on', () => {
	const h = harness();
	h.controller.setService('available');
	assert.equal(h.controller.setDisplay(true), false);
	assert.equal(h.calls.length, 0);
});

/* ---------- drawing ---------- */

test('turning off while cells are still being drawn stops the job and leaves nothing', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	await h.answer('cellSize=100', ok(gridFor(100, (r) => {
		// 300 non-empty cells so that drawing takes three frames
		const base = r.cells.features[0];
		r.cells.features = Array.from({ length: 300 }, (_, i) => ({ ...base, id: 'c' + i,
			properties: { ...base.properties, col: i, row: 0, buildingCount: 1 } }));
		r.grid.returnedCellCount = 300;
	})));
	h.frames.shift()(0);  // first frame: 100 cells
	assert.equal(h.renderer.count(), 100);
	h.controller.setDisplay(false);
	await h.drawAll();

	assert.equal(h.renderer.count(), 0);
	assert.equal(h.created.length, 100);
	assert.equal(h.state().drawing.phase, 'none');
});

test('measurement reset redraws the grid only while it is on', async () => {
	const h = harness();
	await shown(h);
	assert.equal(h.controller.measureReset(), true);
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);
	assert.equal(h.created.length, 16);
	assert.equal(h.state().drawing.phase, 'done');

	h.controller.setDisplay(false);
	assert.equal(h.controller.measureReset(), false);
	await h.drawAll();
	assert.equal(h.renderer.count(), 0);
	assert.equal(h.clearCalls(), 0);
});

test('measurement reset during drawing cancels the old job first', async () => {
	const h = harness();
	h.controller.setService('available');
	h.controller.setAnalysis(live(1));
	h.controller.setDisplay(true);
	await h.answer('cellSize=100', ok(gridFor(100)));
	h.controller.measureReset();  // before the first frame
	await h.drawAll();
	assert.equal(h.renderer.count(), 8);
});

/* ---------- clicks ---------- */

test('cell click: suppresses the next map click, shows the cell, opens the grid view', async () => {
	const h = harness({ mode: 'radius' });
	await shown(h, live(1), 100);
	const center = h.created.find((o, i) => o.listener && h.renderer.getCells()[i].id === '0:0');
	center.listener();

	assert.equal(h.suppressed(), 1);
	assert.equal(h.opened(), 1);
	assert.equal(h.state().selected.title, '셀 0:0 (100m)');
	assert.equal(h.state().selected.rows[0].value, '64.00%');
});

for (const mode of ['distance', 'area', 'coord']) {
	test('cell clicks are ignored in ' + mode + ' mode', async () => {
		const h = harness({ mode });
		await shown(h);
		h.created[0].listener();
		assert.equal(h.suppressed(), 0);
		assert.equal(h.state().selected, null);
	});
}

test('the selection is cleared when the grid changes', async () => {
	const h = harness();
	await shown(h);
	h.created[0].listener();
	assert.notEqual(h.state().selected, null);
	h.controller.setExcludeEmpty(false);
	assert.equal(h.state().selected, null);
});
