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
