// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The renderer against a fake VWorld map. Real VWorld rendering is checked in the browser (8-6B-2d), not here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '../../main/resources/static/js/spatial-grid-renderer.js');
const grid = require(SOURCE);
// A real grid-density response (Python compute_grid_density, r = 100 m, 50 m cells, includeEmptyCells) in the
// Java envelope: 21 cells, 13 empty, 8 small boundary cells.
const GRID = require('./fixtures/grid-density-100m-50.json');

/* ---------- fake VWorld ---------- */

function fakeVWorld(options = {}) {
	const record = { created: [], removed: [], clearCalls: 0, colors: 0, failed: 0 };
	const existing = [{ kind: 'analysis-building' }, { kind: 'search-marker' }];
	class Collection {
		constructor(items) {
			this.items = items;
		}
	}
	class Coord {
		constructor(x, y) {
			this.x = x;
			this.y = y;
		}
	}
	class Color {
		constructor(r, g, b, a) {
			this.rgba = [r, g, b, a];
			record.colors++;
		}
	}
	class PolygonZ {
		constructor(collection) {
			this.points = collection.items.map((c) => [c.x, c.y]);
			this.listener = null;
			this.listenerRemoved = false;
		}

		setFillColor(color) {
			this.color = color;
		}

		create() {
			if (options.failEvery && (record.created.length + record.failed + 1) % options.failEvery === 0) {
				record.failed++;
				throw new Error('engine create failed');
			}
			record.created.push(this);
		}

		addEventListener(fn) {
			this.listener = fn;
		}

		removeEventListener() {
			this.listener = null;
			this.listenerRemoved = true;
		}
	}
	const vw = { geom: { PolygonZ }, Collection, Coord, Color };
	const engine = new Set(existing);
	const map = {
		engine,
		removeObject(obj) {
			if (existing.includes(obj)) {
				throw new Error('removed an object the grid renderer did not create');
			}
			record.removed.push(obj);
			engine.delete(obj);
		},
		clear() {
			record.clearCalls++;
		},
		// What the measurement reset does: the engine forgets every object (the renderer must not call this).
		engineClear() {
			engine.clear();
		}
	};
	const frames = [];
	const env = {
		vw: () => (options.noVw ? undefined : vw),
		raf(cb) {
			if (options.rafThrows) {
				throw new Error('raf failed');
			}
			frames.push(cb);
			return frames.length;
		},
		cancelRaf(id) {
			if (!options.ignoreCancel) {
				frames[id - 1] = null;
			}
		},
		console: { warn() {} }
	};
	// Runs the queued frames one by one (only frames queued before the call), returns how many ran.
	function tick() {
		const queued = frames.splice(0, frames.length);
		let ran = 0;
		queued.forEach((cb) => {
			if (cb) {
				cb(0);
				ran++;
			}
		});
		return ran;
	}
	async function runAll() {
		let guard = 0;
		while (frames.some(Boolean) && guard++ < 1000) {
			tick();
			await Promise.resolve();
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
	return { vw, map, env, record, existing, tick, runAll, frames };
}

function renderer(options) {
	const fake = fakeVWorld(options);
	const r = grid.createRenderer(fake.env);
	if (!options || !options.noMap) {
		r.setMap(fake.map);
	}
	return { ...fake, r };
}

function feature(id, props, ring) {
	return { type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring || square(0.001)] },
		properties: { col: 0, row: 0, centerLon: 127.0005, centerLat: 37.5005, buildingCount: 1, primaryBuildingCount: 1,
			coverageRatio: 0.2, boundary: false, smallBoundary: false, ...props } };
}

function square(size, x = 127, y = 37.5) {
	return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function collection(features) {
	return { type: 'FeatureCollection', features };
}

function manyCells(count) {
	const side = Math.ceil(Math.sqrt(count));
	const features = [];
	for (let i = 0; i < count; i++) {
		const col = (i % side) - Math.floor(side / 2);
		const row = Math.floor(i / side) - Math.floor(side / 2);
		const x = 127 + col * 0.0006;
		const y = 37.5 + row * 0.00045;
		features.push(feature(col + ':' + row, { col, row, centerLon: x + 0.0003, centerLat: y + 0.000225,
			coverageRatio: (i % 100) / 100 }, square(0.0006, x, y).map((p, k) => (k === 2 || k === 3 ? [p[0], y + 0.00045] : p))));
	}
	return collection(features);
}

/* ---------- conversion ---------- */

test('real grid-density cells: closing point dropped, 2% inset toward the cell center, flags kept', () => {
	const prepared = grid.prepareCells(GRID);
	const features = GRID.result.cells.features;

	assert.deepEqual([prepared.total, prepared.invalid, prepared.emptyExcluded, prepared.available, prepared.shown,
		prepared.truncated, prepared.maxCells], [21, 0, 13, 8, 8, 0, 1345]);
	for (const cell of prepared.cells) {
		const source = features.find((f) => f.id === cell.id);
		const ring = source.geometry.coordinates[0];
		const center = [source.properties.centerLon, source.properties.centerLat];
		assert.equal(cell.ring.length, 4);  // 5 positions in, closing point removed
		cell.ring.forEach((p, i) => {
			assert.ok(Math.abs(p[0] - (center[0] + (ring[i][0] - center[0]) * 0.98)) < 1e-12);
			assert.ok(Math.abs(p[1] - (center[1] + (ring[i][1] - center[1]) * 0.98)) < 1e-12);
		});
		assert.equal(cell.coverageClass, grid.coverageClass(source.properties.coverageRatio));
		assert.equal(cell.boundary, source.properties.boundary);
		assert.equal(cell.smallBoundary, source.properties.smallBoundary);
		assert.equal(cell.empty, false);
		assert.equal(cell.col, source.properties.col);
	}
	assert.equal(prepared.cells.find((c) => c.id === '0:0').coverageClass, 4);
	// The same data is accepted as the Java envelope, the Python result or the FeatureCollection itself.
	assert.equal(grid.prepareCells(GRID.result).shown, 8);
	assert.equal(grid.prepareCells(GRID.result.cells).shown, 8);
});

test('empty cells are excluded by default and kept on request', () => {
	const all = grid.prepareCells(GRID, { excludeEmpty: false });
	assert.equal(all.shown, 21);
	assert.equal(all.emptyExcluded, 0);
	assert.equal(all.cells.filter((c) => c.empty).length, 13);
	assert.equal(grid.isEmptyCell({ buildingCount: 0, primaryBuildingCount: 0 }), true);
	assert.equal(grid.isEmptyCell({ buildingCount: 0, primaryBuildingCount: 1 }), false);  // a PARTIAL with no area
	assert.equal(grid.isEmptyCell({ buildingCount: 2, primaryBuildingCount: 0 }), false);
});

test('invalid coordinates and missing properties are skipped and counted, never thrown', () => {
	const bad = [
		{ type: 'Feature', id: 'no-geometry', properties: feature('x').properties },
		feature('wrong-type', {}, null),
		{ ...feature('multi'), geometry: { type: 'MultiPolygon', coordinates: [[square(0.001)]] } },
		feature('nan', {}, [[127, 37.5], [NaN, 37.5], [127.001, 37.501], [127, 37.5]]),
		feature('out-of-range', {}, [[200, 37.5], [127.001, 37.5], [127.001, 37.501], [200, 37.5]]),
		feature('string-coord', {}, [['127', 37.5], [127.001, 37.5], [127.001, 37.501], ['127', 37.5]]),
		feature('too-short', {}, [[127, 37.5], [127.001, 37.5], [127, 37.5]]),
		feature('no-count', { buildingCount: undefined }),
		feature('negative', { primaryBuildingCount: -1 }),
		feature('fraction', { buildingCount: 1.5 }),
		feature('no-ratio', { coverageRatio: undefined }),
		feature('ratio-string', { coverageRatio: '0.2' }),
		feature('ratio-too-big', { coverageRatio: 1.5 }),
		{ ...feature('no-props'), properties: null },
		{ type: 'NotAFeature' },
		null
	];
	bad[1].geometry = { type: 'Polygon', coordinates: null };
	const prepared = grid.prepareCells(collection([...bad, feature('ok')]));

	assert.equal(prepared.total, bad.length + 1);
	assert.equal(prepared.invalid, bad.length);
	assert.deepEqual(prepared.cells.map((c) => c.id), ['ok']);
	for (const notCells of [null, {}, { type: 'FeatureCollection' }, { result: { cells: [] } }, []]) {
		assert.throws(() => grid.prepareCells(notCells), TypeError);
	}
	// An open ring (no closing point) is accepted as is.
	const open = grid.prepareCells(collection([feature('open', {}, square(0.001).slice(0, 4))]));
	assert.equal(open.cells[0].ring.length, 4);
});

test('five coverage classes with inclusive upper limits', () => {
	const cases = [[0, 0], [0.05, 0], [0.0501, 1], [0.15, 1], [0.2, 2], [0.3, 2], [0.31, 3], [0.5, 3], [0.51, 4], [1, 4]];
	for (const [ratio, expected] of cases) {
		assert.equal(grid.coverageClass(ratio), expected, String(ratio));
	}
	for (const invalid of [NaN, -0.1, 1.5, null, '0.2', undefined]) {
		assert.equal(grid.coverageClass(invalid), null);
	}
	assert.deepEqual(grid.COVERAGE_LIMITS, [0.05, 0.15, 0.30, 0.50]);
	assert.equal(grid.COVERAGE_COLORS.length, 5);
});

test('cell styles: class color, lighter boundary cells, grey small boundary cells', () => {
	const style = (extra) => grid.cellStyle({ coverageClass: 3, boundary: false, smallBoundary: false, ...extra });
	assert.deepEqual(style({}), { key: 'c3', rgba: grid.COVERAGE_COLORS[3] });
	const boundary = style({ boundary: true });
	assert.equal(boundary.key, 'c3b');
	assert.ok(boundary.rgba[3] < grid.COVERAGE_COLORS[3][3]);
	assert.deepEqual(boundary.rgba.slice(0, 3), grid.COVERAGE_COLORS[3].slice(0, 3));
	assert.deepEqual(style({ boundary: true, smallBoundary: true }), { key: 'small', rgba: grid.SMALL_BOUNDARY_COLOR });
	const legend = grid.legend();
	assert.equal(legend.length, 7);
	assert.match(legend[0].label, /0~5%/);
	assert.match(legend[4].label, /50% 초과/);
});

test('at most 1,345 cells, nearest to the center first, with the number left out', () => {
	const prepared = grid.prepareCells(manyCells(1500));

	assert.equal(prepared.available, 1500);
	assert.equal(prepared.shown, 1345);
	assert.equal(prepared.truncated, 155);
	const kept = prepared.cells.map((c) => c.col * c.col + c.row * c.row);
	const all = grid.prepareCells(manyCells(1500), { maxCells: 5000 }).cells.map((c) => c.col * c.col + c.row * c.row);
	const threshold = all.sort((a, b) => a - b)[1344];
	assert.ok(kept.every((d) => d <= threshold));
	assert.equal(grid.prepareCells(manyCells(20), { maxCells: 5 }).shown, 5);
});

/* ---------- rendering ---------- */

test('cells are drawn in frames of at most 100, with shared colors and click handlers', async () => {
	const { r, record, tick, runAll } = renderer();
	const cells = grid.prepareCells(manyCells(250)).cells;
	const progress = [];
	const done = r.render(cells, { onProgress: (p) => progress.push(p.created) });

	assert.equal(record.created.length, 0);  // nothing before the first frame
	assert.equal(r.isRendering(), true);
	tick();
	assert.equal(record.created.length, 100);
	tick();
	assert.equal(record.created.length, 200);
	await runAll();
	const result = await done;

	assert.deepEqual(result, { status: 'done', created: 250, errors: 0, total: 250 });
	assert.deepEqual(progress, [100, 200, 250]);
	assert.equal(r.count(), 250);
	assert.equal(r.isRendering(), false);
	assert.ok(record.colors <= 11, 'one vw.Color per style, not per cell');
	assert.deepEqual(record.created[0].points, cells[0].ring);
	const picked = [];
	r.setPickHandler((id) => picked.push(id));
	record.created[5].listener();
	assert.deepEqual(picked, [cells[5].id]);
});

test('chunk size is capped at 100', async () => {
	const { r, record, tick } = renderer();
	r.render(grid.prepareCells(manyCells(300)).cells, { chunkSize: 500 });
	tick();
	assert.equal(record.created.length, 100);
	r.clear();
});

test('cancel during a job stops it and removes everything it drew', async () => {
	const { r, record, tick, runAll } = renderer();
	const done = r.render(grid.prepareCells(manyCells(300)).cells);
	tick();
	assert.equal(r.count(), 100);
	const removed = r.cancel();
	const result = await done;

	assert.equal(removed, 100);
	assert.equal(result.status, 'cancelled');
	assert.equal(r.count(), 0);
	assert.equal(r.hasCells(), false);
	await runAll();
	assert.equal(record.created.length, 100);  // no cell after the cancel
	assert.equal(record.removed.length, 100);
});

test('a stale frame of an old job creates nothing, even if it still fires', async () => {
	const { r, record, frames, runAll } = renderer({ ignoreCancel: true });
	const first = r.render(grid.prepareCells(manyCells(300)).cells);
	frames.shift()(0);  // first job: 100 cells
	const second = r.render(grid.prepareCells(manyCells(50)).cells);
	await runAll();     // the old job's next frame still fires (cancelRaf ignored)

	assert.equal((await first).status, 'cancelled');
	assert.deepEqual(await second, { status: 'done', created: 50, errors: 0, total: 50 });
	assert.equal(r.count(), 50);
	assert.equal(record.created.length, 150);
	// Every object of the first job was removed; only the second job's objects are on the map.
	assert.ok(record.created.slice(0, 100).every((obj) => record.removed.includes(obj)));
	assert.ok(record.created.slice(100).every((obj) => !record.removed.includes(obj)));
});

test('repeated render and clear leave no objects and no listeners', async () => {
	const { r, record, runAll } = renderer();
	const cells = grid.prepareCells(manyCells(120)).cells;
	for (let i = 0; i < 20; i++) {
		const done = r.render(cells);
		await runAll();
		assert.equal((await done).created, 120);
		r.clear();
	}

	assert.equal(record.created.length, 2400);
	assert.equal(record.removed.length, 2400);
	assert.equal(r.count(), 0);
	assert.ok(record.created.every((obj) => obj.listenerRemoved && obj.listener === null));
	const stats = r.getStats();
	assert.deepEqual([stats.created, stats.removed, stats.objects, stats.cells, stats.rendering],
		[2400, 2400, 0, 0, false]);
	assert.equal(record.clearCalls, 0);
});

test('drawing again removes the previous grid first (cell size change)', async () => {
	const { r, record, runAll } = renderer();
	r.render(grid.prepareCells(manyCells(80)).cells);
	await runAll();
	const before = record.created.slice();
	r.render(grid.prepareCells(manyCells(30)).cells);
	await runAll();

	assert.ok(before.every((obj) => record.removed.includes(obj) && obj.listenerRemoved));
	assert.equal(r.count(), 30);
});

test('restore after a measurement reset draws the kept cells again', async () => {
	const { r, map, record, runAll, existing } = renderer();
	const cells = grid.prepareCells(GRID).cells;
	r.render(cells);
	await runAll();
	map.engineClear();  // map-tools.js: vw.Map.clear() then gis:measurereset
	const restored = r.restore();
	await runAll();

	assert.deepEqual(await restored, { status: 'done', created: 8, errors: 0, total: 8 });
	assert.equal(r.count(), 8);
	assert.equal(record.created.length, 16);
	assert.equal(record.clearCalls, 0);
	assert.ok(existing.every((obj) => !record.removed.includes(obj)));
	// After clear() there is nothing to restore.
	r.clear();
	assert.deepEqual(await r.restore(), { status: 'done', created: 0, errors: 0, total: 0 });
});

test('kept cell definitions are plain data without VWorld objects', async () => {
	const { r, runAll } = renderer();
	const prepared = grid.prepareCells(GRID);
	r.render(prepared.cells);
	await runAll();
	const kept = r.getCells();

	assert.deepEqual(JSON.parse(JSON.stringify(kept)), kept);
	const plain = (value) => value === null || typeof value !== 'object'
		|| ((Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) && Object.values(value).every(plain));
	assert.ok(kept.every(plain));
	// Changing the caller's array afterwards does not change what is kept.
	prepared.cells[0].ring[0][0] = 0;
	assert.notEqual(r.getCells()[0].ring[0][0], 0);
});

test('creation errors are counted, partly created objects removed', async () => {
	const { r, record, runAll } = renderer({ failEvery: 5 });
	const done = r.render(grid.prepareCells(manyCells(50)).cells);
	await runAll();
	const result = await done;

	assert.equal(result.errors, 10);
	assert.equal(result.created, 40);
	assert.equal(r.count(), 40);
	assert.equal(r.getStats().createErrors, 10);
});

test('no VWorld, no map or a failing frame scheduler: nothing is drawn and nothing hangs', async () => {
	assert.equal((await renderer({ noVw: true }).r.render([{ id: 'a', ring: [[1, 1], [2, 1], [2, 2]] }])).status, 'unsupported');
	assert.equal((await renderer({ noMap: true }).r.render(grid.prepareCells(GRID).cells)).status, 'unsupported');
	const failing = renderer({ rafThrows: true });
	assert.equal((await failing.r.render(grid.prepareCells(GRID).cells)).status, 'failed');
	assert.equal(failing.r.isRendering(), false);
	assert.equal(failing.r.count(), 0);
});

test('switching to another map clears the old grid', async () => {
	const { r, record, runAll } = renderer();
	r.render(grid.prepareCells(GRID).cells);
	await runAll();
	r.setMap(fakeVWorld().map);

	assert.equal(r.count(), 0);
	assert.equal(record.removed.length, 8);
});

/* ---------- browser loading and API rules ---------- */

test('in the browser it defines window.gisGridRenderer and connects on gis:mapready', () => {
	const listeners = {};
	const fake = fakeVWorld();
	const window = {
		vw: fake.vw,
		console: { warn() {} },
		requestAnimationFrame: () => 1,
		cancelAnimationFrame() {}
	};
	const document = { addEventListener: (type, fn) => { listeners[type] = fn; } };
	vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), vm.createContext({ window, document }));

	assert.equal(typeof window.gisGridRenderer.render, 'function');
	assert.equal(window.gisGridRenderer.isSupported(), false);
	listeners['gis:mapready']({ detail: { map: fake.map } });
	assert.equal(window.gisGridRenderer.isSupported(), true);
});

test('only public VWorld calls: no map.clear, no show/hide, no VWorld or Cesium internals', () => {
	const code = fs.readFileSync(SOURCE, 'utf8').split('\n')
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');  // code only, not comments
	assert.doesNotMatch(code, /state\.map\.clear|\.map\.clear|map\.clear\(/);
	assert.doesNotMatch(code, /\.show\(|\.hide\(|setVisible|setShow/);
	assert.doesNotMatch(code, /ws3d|Cesium|objectManager|_options|viewer/);
	assert.doesNotMatch(code, /innerHTML|fetch\(|XMLHttpRequest/);
	for (const used of ['geom.PolygonZ', 'Collection', 'Coord', 'Color', 'setFillColor', 'create()', 'addEventListener',
		'removeEventListener', 'removeObject']) {
		assert.ok(code.includes(used), used);
	}
});

/* ---------- hotspot cells and injected styles (8-7-4) ---------- */

// A real hotspot response (Python compute_hotspot, r = 350 m, 50 m cells, 999 permutations) in the Java envelope:
// 185 cells with all eight classes, 69 cells without buildings, 56 boundary cells of which 24 are small (NOT_TESTED).
const HOTSPOT = require('./fixtures/hotspot-350m-50.json');
const HOTSPOT_FEATURES = HOTSPOT.result.cells.features;
const ALL_CLASSES = ['HOT_99', 'HOT_95', 'HOT_90', 'NOT_SIGNIFICANT', 'COLD_90', 'COLD_95', 'COLD_99', 'NOT_TESTED'];

function rgbaOf(obj) {
	return obj.color.rgba;
}

function hotspotFeature(id, props, ring) {
	return { type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring || square(0.001)] },
		properties: { col: 0, row: 0, centerLon: 127.0005, centerLat: 37.5005, boundary: false, smallBoundary: false,
			domainRatio: 1, coverageRatio: 0, neighborCount: 8, giZ: 0.5, pValue: 0.6, qValue: 0.9,
			hotspotClass: 'NOT_SIGNIFICANT', bin: 0, reason: null, ...props } };
}

// manyCells(count) as hotspot cells, the classes in turn.
function manyHotspotCells(count) {
	const fc = manyCells(count);
	fc.features = fc.features.map((f, i) => hotspotFeature(f.id, { col: f.properties.col, row: f.properties.row,
		centerLon: f.properties.centerLon, centerLat: f.properties.centerLat, hotspotClass: ALL_CLASSES[i % 8] },
	f.geometry.coordinates[0]));
	return fc;
}

// Records the renderer warnings (the renderer keeps env.console, so replacing warn afterwards works).
function warnings(fake) {
	const list = [];
	fake.env.console.warn = (...args) => list.push(args);
	return list;
}

test('without styleFn the grid colors, results and kept cells are exactly as before', async () => {
	const { r, record, runAll } = renderer();
	const cells = grid.prepareCells(GRID, { excludeEmpty: false }).cells;
	const done = r.render(cells, { chunkSize: 100 });
	await runAll();

	assert.deepEqual(await done, { status: 'done', created: 21, errors: 0, total: 21 });  // no styleErrors field
	record.created.forEach((obj, i) => assert.deepEqual(rgbaOf(obj), grid.cellStyle(cells[i]).rgba));
	// One color per default key (cN, cNb, small), as before.
	const keys = new Set(cells.map((c) => grid.cellStyle(c).key));
	assert.equal(record.colors, keys.size);
	assert.equal(r.getStats().colors, keys.size);
	for (const kept of r.getCells()) {
		assert.deepEqual(Object.keys(kept), ['id', 'col', 'row', 'ring', 'center', 'coverageRatio', 'coverageClass',
			'buildingCount', 'primaryBuildingCount', 'boundary', 'smallBoundary', 'empty']);
	}
	assert.equal(r.getStats().styleErrors, 0);
	// options.styleFn null or undefined is the same as no styleFn.
	for (const styleFn of [null, undefined]) {
		const again = r.render(cells, { styleFn });
		await runAll();
		assert.deepEqual(await again, { status: 'done', created: 21, errors: 0, total: 21 });
	}
	assert.equal(record.colors, keys.size);
});

test('real hotspot cells: every cell kept in response order, empty cells included, statistics as plain values', () => {
	const prepared = grid.prepareHotspotCells(HOTSPOT);

	assert.deepEqual([prepared.total, prepared.invalid, prepared.emptyExcluded, prepared.available, prepared.shown,
		prepared.truncated, prepared.maxCells], [185, 0, 0, 185, 185, 0, 1345]);
	assert.deepEqual(prepared.cells.map((c) => c.id), HOTSPOT_FEATURES.map((f) => f.id));
	assert.equal(prepared.cells.filter((c) => c.coverageRatio === 0).length, 69);
	prepared.cells.forEach((cell, i) => {
		const props = HOTSPOT_FEATURES[i].properties;
		const ring = HOTSPOT_FEATURES[i].geometry.coordinates[0];
		assert.equal(cell.ring.length, 4);  // closing point removed
		cell.ring.forEach((p, k) => {
			assert.ok(Math.abs(p[0] - (props.centerLon + (ring[k][0] - props.centerLon) * 0.98)) < 1e-12);
			assert.ok(Math.abs(p[1] - (props.centerLat + (ring[k][1] - props.centerLat) * 0.98)) < 1e-12);
		});
		assert.deepEqual(cell.hotspot, { hotspotClass: props.hotspotClass, bin: props.bin, giZ: props.giZ,
			pValue: props.pValue, qValue: props.qValue, reason: props.reason, neighborCount: props.neighborCount });
		assert.deepEqual([cell.col, cell.row, cell.boundary, cell.smallBoundary, cell.coverageRatio],
			[props.col, props.row, props.boundary, props.smallBoundary, props.coverageRatio]);
	});
	assert.deepEqual(new Set(prepared.cells.map((c) => c.hotspot.hotspotClass)), new Set(ALL_CLASSES));
	// The Python result or the FeatureCollection itself are accepted too.
	assert.equal(grid.prepareHotspotCells(HOTSPOT.result).shown, 185);
	assert.equal(grid.prepareHotspotCells(HOTSPOT.result.cells).shown, 185);
	// The grid-density preparation still rejects hotspot cells (no building counts): its behaviour is unchanged.
	assert.equal(grid.prepareCells(HOTSPOT, { excludeEmpty: false }).invalid, 185);
});

test('hotspot cells with an unknown class or a bad polygon are skipped and counted, never thrown', () => {
	const bad = [
		hotspotFeature('no-class', { hotspotClass: undefined }),
		hotspotFeature('unknown-class', { hotspotClass: 'HOT_80' }),
		hotspotFeature('lower-case', { hotspotClass: 'hot_99' }),
		hotspotFeature('nan', {}, [[127, 37.5], [NaN, 37.5], [127.001, 37.501], [127, 37.5]]),
		hotspotFeature('out-of-range', {}, [[200, 37.5], [127.001, 37.5], [127.001, 37.501], [200, 37.5]]),
		hotspotFeature('too-short', {}, [[127, 37.5], [127.001, 37.5], [127, 37.5]]),
		{ ...hotspotFeature('multi'), geometry: { type: 'MultiPolygon', coordinates: [[square(0.001)]] } },
		{ ...hotspotFeature('no-geometry'), geometry: null },
		{ ...hotspotFeature('no-props'), properties: null },
		{ type: 'NotAFeature' },
		null
	];
	const odd = hotspotFeature('odd-values', { giZ: 'x', pValue: NaN, bin: undefined, reason: 5, coverageRatio: '0' });
	const prepared = grid.prepareHotspotCells(collection([...bad, hotspotFeature('ok'), odd]));

	assert.equal(prepared.total, bad.length + 2);
	assert.equal(prepared.invalid, bad.length);
	assert.deepEqual(prepared.cells.map((c) => c.id), ['ok', 'odd-values']);
	// Values that are not plain numbers or strings are kept as null, never passed through.
	assert.deepEqual(prepared.cells[1].hotspot, { hotspotClass: 'NOT_SIGNIFICANT', bin: null, giZ: null, pValue: null,
		qValue: 0.9, reason: null, neighborCount: 8 });
	assert.equal(prepared.cells[1].coverageRatio, null);
	for (const notCells of [null, {}, { type: 'FeatureCollection' }, []]) {
		assert.throws(() => grid.prepareHotspotCells(notCells), TypeError);
	}
});

test('eight hotspot classes: map and legend share one color table, NOT_TESTED kept apart from the scale', () => {
	assert.deepEqual(grid.HOTSPOT_CLASSES, ALL_CLASSES);
	assert.deepEqual(grid.HOTSPOT_COLORS, {
		HOT_99: [178, 24, 43, 200], HOT_95: [239, 138, 98, 185], HOT_90: [253, 219, 199, 175],
		NOT_SIGNIFICANT: [247, 247, 247, 90], COLD_90: [209, 229, 240, 175], COLD_95: [103, 169, 207, 185],
		COLD_99: [33, 102, 172, 200], NOT_TESTED: [100, 116, 139, 130] });
	const legend = grid.hotspotLegend();
	assert.deepEqual(legend.map((item) => item.key), ALL_CLASSES);
	for (const item of legend) {
		assert.deepEqual(grid.hotspotStyle({ hotspot: { hotspotClass: item.key } }), { key: item.key, rgba: item.rgba });
		assert.deepEqual(item.rgba, grid.HOTSPOT_COLORS[item.key]);
		assert.equal(item.group, item.key === 'NOT_TESTED' ? 'notTested' : 'scale');
	}
	assert.match(legend[3].label, /유의하지 않음/);
	assert.match(legend[7].label, /검정하지 않음/);
	assert.equal(new Set(legend.map((item) => item.label)).size, 8);
	// Every class has its own color; NOT_TESTED is neither a scale color nor the grid small-boundary grey.
	assert.equal(new Set(legend.map((item) => item.rgba.join(','))).size, 8);
	assert.notDeepEqual(grid.HOTSPOT_COLORS.NOT_TESTED, grid.SMALL_BOUNDARY_COLOR);
	// Unknown classes have no style; returned arrays are copies.
	for (const cell of [null, {}, { hotspot: null }, { hotspot: { hotspotClass: 'HOT_80' } }]) {
		assert.equal(grid.hotspotStyle(cell), null);
	}
	grid.hotspotStyle({ hotspot: { hotspotClass: 'HOT_99' } }).rgba[0] = 0;
	grid.hotspotLegend()[0].rgba[0] = 0;
	assert.equal(grid.HOTSPOT_COLORS.HOT_99[0], 178);
});

test('hotspot map colors follow the class, boundary cells are not lightened, small boundary cells are NOT_TESTED',
	async () => {
		const { r, record, runAll } = renderer();
		const cells = grid.prepareHotspotCells(HOTSPOT).cells;
		const done = r.render(cells, { styleFn: grid.hotspotStyle });
		await runAll();

		assert.deepEqual(await done, { status: 'done', created: 185, errors: 0, total: 185, styleErrors: 0 });
		cells.forEach((cell, i) => {
			assert.deepEqual(rgbaOf(record.created[i]), grid.HOTSPOT_COLORS[cell.hotspot.hotspotClass], cell.id);
		});
		// Tested boundary cells include significant ones, drawn with the full class color (checked above).
		const boundary = cells.filter((c) => c.boundary && !c.smallBoundary);
		assert.ok(boundary.some((c) => c.hotspot.hotspotClass.startsWith('COLD_')));
		assert.ok(cells.filter((c) => c.smallBoundary).every((c) => c.hotspot.hotspotClass === 'NOT_TESTED'));
		assert.equal(record.colors, 8, 'one vw.Color per class');
	});

test('invalid styleFn results skip only that cell, never fall back to grid colors', async () => {
	const fake = renderer();
	const warned = warnings(fake);
	const { r, record, runAll } = fake;
	const cells = grid.prepareHotspotCells(manyHotspotCells(30)).cells;
	const badResults = [null, undefined, {}, 'red', [1, 2, 3, 4], { rgba: [1, 2, 3] }, { rgba: [1, 2, 3, 4, 5] },
		{ rgba: [256, 0, 0, 1] }, { rgba: [-1, 0, 0, 1] }, { rgba: [1.5, 0, 0, 1] }, { rgba: [NaN, 0, 0, 1] },
		{ rgba: ['1', 0, 0, 1] }, { rgba: [1, 2, 3, 4], key: 7 }, { rgba: { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 } }];
	const done = r.render(cells, { styleFn: (cell) => {
		const i = cells.findIndex((c) => c.id === cell.id);
		return i < badResults.length ? badResults[i] : { rgba: [0, 255, 0, 255], key: 'ok' };
	} });
	await runAll();

	assert.deepEqual(await done, { status: 'done', created: 30 - badResults.length, errors: badResults.length,
		total: 30, styleErrors: badResults.length });
	assert.ok(record.created.every((obj) => rgbaOf(obj).join(',') === '0,255,0,255'));
	assert.equal(record.colors, 1);
	assert.equal(r.getStats().styleErrors, badResults.length);
	assert.equal(r.getStats().createErrors, 0);
	assert.equal(warned.length, 1, 'one warning per render');
	assert.match(String(warned[0][0]), new RegExp(badResults.length + '개'));
	// Edge values 0 and 255 are valid.
	const edge = r.render(cells.slice(0, 1), { styleFn: () => ({ rgba: [0, 0, 255, 0] }) });
	await runAll();
	assert.equal((await edge).created, 1);
});

test('a throwing styleFn skips those cells, keeps the rest and warns once', async () => {
	const fake = renderer();
	const warned = warnings(fake);
	const { r, record, runAll } = fake;
	const cells = grid.prepareHotspotCells(HOTSPOT).cells;
	const done = r.render(cells, { styleFn: (cell) => {
		if (cell.hotspot.hotspotClass === 'NOT_SIGNIFICANT') {
			throw new Error('style failed');
		}
		return grid.hotspotStyle(cell);
	} });
	await runAll();

	assert.deepEqual(await done, { status: 'done', created: 53, errors: 132, total: 185, styleErrors: 132 });
	assert.equal(r.count(), 53);
	assert.ok(record.created.every((obj) => rgbaOf(obj).join(',') !== grid.HOTSPOT_COLORS.NOT_SIGNIFICANT.join(',')));
	assert.equal(warned.length, 1);
	assert.equal(warned[0][1].message, 'style failed');
	// A styleFn that throws for every cell still finishes.
	const all = r.render(cells, { styleFn: () => { throw new Error('all'); } });
	await runAll();
	assert.deepEqual(await all, { status: 'done', created: 0, errors: 185, total: 185, styleErrors: 185 });
	assert.equal(warned.length, 2);
});

test('a styleFn that is not a function fails the whole render without drawing or keeping cells', async () => {
	for (const styleFn of ['red', 42, {}, [], true]) {
		const fake = renderer();
		const warned = warnings(fake);
		const { r, record, runAll } = fake;
		r.render(grid.prepareCells(GRID).cells);
		await runAll();
		const done = r.render(grid.prepareHotspotCells(HOTSPOT).cells, { styleFn });
		await runAll();  // run any frame first, so a wrongly started job fails here instead of never resolving

		assert.deepEqual(await done,{ status: 'failed', created: 0, errors: 0, total: 185, styleErrors: 0 });
		assert.equal(r.count(), 0, 'the previous grid is removed as for any new render');
		assert.equal(record.created.length, 8);
		assert.equal(r.hasCells(), false);
		assert.equal(r.isRendering(), false);
		assert.deepEqual(await r.restore(), { status: 'done', created: 0, errors: 0, total: 0 });
		assert.equal(warned.length, 1);
	}
});

test('styleFn gets an independent copy: changing it changes neither the kept cells nor the drawing', async () => {
	const { r, record, runAll } = renderer();
	const cells = grid.prepareHotspotCells(HOTSPOT).cells;
	const before = JSON.parse(JSON.stringify(cells));
	const seen = [];
	r.render(cells, { styleFn: (cell) => {
		seen.push(cell);
		const style = grid.hotspotStyle(cell);
		cell.ring[0][0] = 0;
		cell.ring.push([1, 1]);
		cell.hotspot.hotspotClass = 'HOT_99';
		cell.id = 'changed';
		return style;
	} });
	await runAll();

	assert.equal(seen.length, 185, 'called once per cell');
	assert.ok(seen.every((copy, i) => copy !== cells[i]));
	assert.deepEqual(cells, before, 'the caller cells are untouched');
	r.getCells().forEach((cell, i) => {
		assert.deepEqual(cell.ring, before[i].ring);
		assert.equal(cell.id, before[i].id);
		assert.deepEqual(cell.hotspot, before[i].hotspot);
		assert.deepEqual(cell.style, { rgba: grid.HOTSPOT_COLORS[before[i].hotspot.hotspotClass] });
	});
	record.created.forEach((obj, i) => assert.deepEqual(obj.points, before[i].ring));
	// Clicks still report the original cell id.
	const picked = [];
	r.setPickHandler((id) => picked.push(id));
	record.created[3].listener();
	assert.deepEqual(picked, [before[3].id]);
});

test('injected style keys never collide with grid color keys; equal rgba share one vw.Color', async () => {
	const { r, record, runAll } = renderer();
	const gridCells = grid.prepareCells(GRID).cells;
	r.render(gridCells);  // creates the c4 / c4b / small colors
	await runAll();
	const gridColors = record.colors;
	r.render(grid.prepareHotspotCells(manyHotspotCells(40)).cells, { styleFn: (cell) => (
		Number(cell.id.split(':')[0]) % 2 ? { key: 'c4', rgba: [1, 2, 3, 4] } : { key: 'small', rgba: [5, 6, 7, 8] }) });
	await runAll();

	const drawn = record.created.slice(8);
	assert.equal(drawn.length, 40);
	assert.ok(drawn.every((obj) => ['1,2,3,4', '5,6,7,8'].includes(rgbaOf(obj).join(','))));
	assert.equal(record.colors, gridColors + 2);
	// The grid colors are still the grid colors afterwards, taken from the cache.
	r.render(gridCells);
	await runAll();
	record.created.slice(-8).forEach((obj, i) => assert.deepEqual(rgbaOf(obj), grid.cellStyle(gridCells[i]).rgba));
	assert.equal(record.colors, gridColors + 2);
});

test('restore after a measurement reset reuses the computed colors without calling styleFn again', async () => {
	const { r, map, record, runAll } = renderer();
	const cells = grid.prepareHotspotCells(HOTSPOT).cells;
	let calls = 0;
	r.render(cells, { styleFn: (cell) => {
		calls++;
		return cell.hotspot.hotspotClass === 'HOT_90' ? null : grid.hotspotStyle(cell);
	} });
	await runAll();
	const first = record.created.map((obj) => rgbaOf(obj).join(','));
	map.engineClear();
	const restored = r.restore();
	await runAll();

	assert.equal(calls, 185);
	assert.deepEqual(await restored, { status: 'done', created: 181, errors: 4, total: 185, styleErrors: 4 });
	assert.deepEqual(record.created.slice(181).map((obj) => rgbaOf(obj).join(',')), first);
	assert.equal(record.colors, 7);
	assert.equal(r.getStats().styleErrors, 8, 'counted on each drawing');
	// The kept definitions still carry the statistics for the click detail, as plain data.
	assert.deepEqual(r.getCells().map((c) => c.hotspot), cells.map((c) => c.hotspot));
	assert.deepEqual(JSON.parse(JSON.stringify(r.getCells())), r.getCells());
});

test('drawing the grid again after injected colors goes back to the grid colors', async () => {
	const { r, record, runAll } = renderer();
	const gridCells = grid.prepareCells(GRID, { excludeEmpty: false }).cells;
	r.render(gridCells, { styleFn: () => ({ rgba: [9, 9, 9, 9] }) });
	await runAll();
	// Even cells copied from the styled renderer lose their style when drawn without styleFn.
	const done = r.render(r.getCells());
	await runAll();

	assert.deepEqual(await done, { status: 'done', created: 21, errors: 0, total: 21 });
	record.created.slice(21).forEach((obj, i) => assert.deepEqual(rgbaOf(obj), grid.cellStyle(gridCells[i]).rgba));
	assert.ok(r.getCells().every((c) => !('style' in c)));
	const restored = r.restore();
	await runAll();
	assert.deepEqual(await restored, { status: 'done', created: 21, errors: 0, total: 21 });
	record.created.slice(42).forEach((obj, i) => assert.deepEqual(rgbaOf(obj), grid.cellStyle(gridCells[i]).rgba));
});

test('cancel or clear during a styled render: no late frame draws, no objects or listeners left', async () => {
	const { r, record, tick, runAll } = renderer({ ignoreCancel: true });
	const cells = grid.prepareHotspotCells(manyHotspotCells(300)).cells;
	const first = r.render(cells, { styleFn: grid.hotspotStyle });
	tick();
	assert.equal(r.count(), 100);
	assert.equal(r.cancel(), 100);
	assert.deepEqual(await first, { status: 'cancelled', created: 100, errors: 0, total: 300, styleErrors: 0 });
	await runAll();  // the cancelled job's frame still fires (cancelRaf ignored)
	assert.equal(record.created.length, 100);

	for (let i = 0; i < 10; i++) {
		const done = r.render(cells, { styleFn: grid.hotspotStyle });
		tick();
		r.clear();
		await runAll();
		assert.equal((await done).status, 'cancelled');
	}
	assert.equal(record.created.length, 1100);
	assert.equal(r.count(), 0);
	assert.equal(record.created.length, record.removed.length);
	assert.ok(record.created.every((obj) => obj.listenerRemoved && obj.listener === null));
	assert.equal(record.clearCalls, 0);
	assert.equal(r.hasCells(), false);
	assert.equal(r.getStats().objects, 0);
});

test('1,345 hotspot cells are drawn in 14 frames of at most 100; more are cut nearest to the center first', async () => {
	const { r, record, tick } = renderer();
	const prepared = grid.prepareHotspotCells(manyHotspotCells(1345));
	assert.deepEqual([prepared.shown, prepared.truncated, prepared.invalid], [1345, 0, 0]);
	const progress = [];
	const done = r.render(prepared.cells, { styleFn: grid.hotspotStyle, onProgress: (p) => progress.push(p.created) });
	let frames = 0;
	while (r.isRendering() && frames < 100) {
		const before = record.created.length;
		tick();
		frames++;
		assert.ok(record.created.length - before <= 100);
	}

	assert.equal(frames, 14);
	assert.equal(progress[progress.length - 1], 1345);
	assert.deepEqual(await done, { status: 'done', created: 1345, errors: 0, total: 1345, styleErrors: 0 });
	assert.equal(record.colors, 8);

	const over = grid.prepareHotspotCells(manyHotspotCells(1500));
	assert.deepEqual([over.available, over.shown, over.truncated], [1500, 1345, 155]);
	const distance = (c) => c.col * c.col + c.row * c.row;
	const all = grid.prepareHotspotCells(manyHotspotCells(1500), { maxCells: 5000 }).cells.map(distance)
		.sort((a, b) => a - b);
	assert.ok(over.cells.every((c) => distance(c) <= all[1344]));
	assert.equal(grid.prepareHotspotCells(manyHotspotCells(20), { maxCells: 5 }).shown, 5);
});

test('two renderers on one map manage only their own objects', async () => {
	const fake = fakeVWorld();
	const gridRenderer = grid.createRenderer(fake.env);
	const hotspotRenderer = grid.createRenderer(fake.env);
	gridRenderer.setMap(fake.map);
	hotspotRenderer.setMap(fake.map);
	gridRenderer.render(grid.prepareCells(GRID).cells);
	await fake.runAll();
	const gridObjects = fake.record.created.slice();
	hotspotRenderer.render(grid.prepareHotspotCells(HOTSPOT).cells, { styleFn: grid.hotspotStyle });
	await fake.runAll();

	assert.equal(gridRenderer.count(), 8);
	assert.equal(hotspotRenderer.count(), 185);
	assert.equal(hotspotRenderer.clear(), 185);
	assert.equal(gridRenderer.count(), 8);
	assert.ok(gridObjects.every((obj) => !fake.record.removed.includes(obj) && obj.listener));
	// Restoring one renderer after a measurement reset does not redraw the other.
	fake.map.engineClear();
	const restored = gridRenderer.restore();
	await fake.runAll();
	await restored;
	assert.equal(gridRenderer.count(), 8);
	assert.equal(hotspotRenderer.count(), 0);
	assert.equal(hotspotRenderer.hasCells(), false);
	// Clearing the grid renderer leaves a hotspot drawing alone.
	hotspotRenderer.render(grid.prepareHotspotCells(HOTSPOT).cells, { styleFn: grid.hotspotStyle });
	await fake.runAll();
	gridRenderer.clear();
	assert.equal(hotspotRenderer.count(), 185);
});

test('attachRenderer makes an independent browser renderer; detach removes its listener and objects', async () => {
	const listeners = [];
	const fake = fakeVWorld();
	const window = { vw: fake.vw, console: { warn() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
	const document = {
		addEventListener: (type, fn) => listeners.push({ type, fn }),
		removeEventListener: (type, fn) => {
			const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
			if (i >= 0) {
				listeners.splice(i, 1);
			}
		}
	};
	vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), vm.createContext({ window, document }));
	assert.equal(listeners.length, 1, 'install adds one gis:mapready listener, as before');
	const hotspotRenderer = window.gisGridModel.attachRenderer(window, document);

	assert.notEqual(hotspotRenderer, window.gisGridRenderer);
	// Every call adds one more listener: a page should attach each renderer once.
	assert.deepEqual(listeners.map((l) => l.type), ['gis:mapready', 'gis:mapready']);
	listeners.forEach((l) => l.fn({ detail: { map: fake.map } }));
	assert.equal(window.gisGridRenderer.isSupported(), true);
	assert.equal(hotspotRenderer.isSupported(), true);

	hotspotRenderer.detach();
	hotspotRenderer.detach();  // twice is harmless
	assert.equal(listeners.length, 1, 'only the grid renderer listener is left');
	assert.equal(hotspotRenderer.isSupported(), false);
	assert.equal(window.gisGridRenderer.isSupported(), true);
	// A renderer attached after the map is ready connects at once.
	window.gisMap = fake.map;
	const late = window.gisGridModel.attachRenderer(window, document);
	assert.equal(late.isSupported(), true);
	late.detach();
	assert.equal(listeners.length, 1);
});

test('the model keeps every earlier name next to the hotspot additions', () => {
	for (const name of ['MAX_CELLS', 'CHUNK_SIZE', 'INSET', 'COVERAGE_LIMITS', 'COVERAGE_COLORS', 'SMALL_BOUNDARY_COLOR',
		'coverageClass', 'isEmptyCell', 'prepareCells', 'cellStyle', 'legend', 'createRenderer', 'install',
		'HOTSPOT_CLASSES', 'HOTSPOT_COLORS', 'prepareHotspotCells', 'hotspotStyle', 'hotspotLegend', 'attachRenderer']) {
		assert.ok(name in grid, name);
	}
	const r = grid.createRenderer(fakeVWorld().env);
	for (const name of ['setMap', 'setPickHandler', 'isSupported', 'render', 'restore', 'cancel', 'clear', 'count',
		'isRendering', 'hasCells', 'getCells', 'getStats']) {
		assert.equal(typeof r[name], 'function', name);
	}
	assert.equal(grid.MAX_CELLS, 1345);
	assert.equal(grid.CHUNK_SIZE, 100);
	assert.equal(grid.legend().length, 7);
});
