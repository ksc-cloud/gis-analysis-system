// node --test "tools/grid-bench/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// These tests check the tool's own logic with a fake VWorld map. They say nothing about real VWorld performance.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, 'grid-bench.js');
const bench = require(SOURCE);
const CENTER = { lon: 126.978, lat: 37.5665 };

/* ---------- fake VWorld ---------- */

function fakeEnv(options = {}) {
	let clock = 0;
	let heapBytes = 50_000_000;
	let rafCalls = 0;
	const pendingRaf = new Map();
	const pendingTimers = new Map();
	let nextId = 1;
	const record = { created: [], removed: [], clearCalls: 0, moves: 0, failedCreates: 0, observers: [] };
	const existing = [{ kind: 'analysis-polygon' }, { kind: 'search-marker' }, { kind: 'measure-label' }];

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
		}
	}
	class PolygonZ {
		constructor(collection) {
			if (options.badCollection && !Array.isArray(collection.items)) {
				throw new Error('bad collection');
			}
			this.points = collection.items;
			this.listener = null;
			this.listenerRemoved = false;
		}

		setFillColor(color) {
			this.color = color;
		}

		create() {
			const n = record.created.length + record.failedCreates + 1;
			if (options.failEvery && n % options.failEvery === 0) {
				record.failedCreates++;
				throw new Error('engine create failed');
			}
			clock += options.createCostMs || 0.2;
			heapBytes += options.heapPerCell || 1000;
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
	const vw = { geom: { PolygonZ }, Collection, Coord, Color,
		CameraPosition: class { constructor(c, d) { this.c = c; this.d = d; } },
		CoordZ: class { constructor(x, y, z) { this.v = [x, y, z]; } },
		Direction: class { constructor(h, t, r) { this.v = [h, t, r]; } } };
	const map = {
		objects: new Set(existing),
		removeObject(obj) {
			if (existing.includes(obj)) {
				throw new Error('removed an object the benchmark did not create');
			}
			if (options.removeThrows) {
				throw new Error('engine remove failed');
			}
			record.removed.push(obj);
			heapBytes -= options.heapPerCell || 1000;
			heapBytes += options.leakPerCell || 0;
		},
		clear() {
			record.clearCalls++;
		},
		moveTo() {
			record.moves++;
		}
	};
	class FakeObserver {
		constructor(callback) {
			this.callback = callback;
			this.disconnected = false;
			record.observers.push(this);
		}

		observe(init) {
			this.type = init.type;
			// A long task as soon as observation starts.
			setImmediate(() => !this.disconnected && this.callback({ getEntries: () => [{ duration: 120 }, { duration: 80 }] }));
		}

		takeRecords() {
			return [];
		}

		disconnect() {
			this.disconnected = true;
		}
	}
	FakeObserver.supportedEntryTypes = ['longtask'];

	const env = {
		vw: () => (options.noVw ? undefined : vw),
		map: () => (options.noMap ? null : map),
		now: () => clock,
		raf(cb) {
			rafCalls++;
			if (options.rafThrowsAfter && rafCalls > options.rafThrowsAfter) {
				throw new Error('raf failed');
			}
			const id = nextId++;
			if (options.rafNeverFires) {
				pendingRaf.set(id, null);  // like a background tab: frames stop arriving
				return id;
			}
			pendingRaf.set(id, setImmediate(() => {
				pendingRaf.delete(id);
				clock += 16;
				cb(clock);
			}));
			return id;
		},
		cancelRaf(id) {
			clearImmediate(pendingRaf.get(id));
			pendingRaf.delete(id);
		},
		setTimeout(fn, ms) {
			const id = nextId++;
			pendingTimers.set(id, setTimeout(() => {
				pendingTimers.delete(id);
				clock += ms;
				fn();
			}, 0));
			return id;
		},
		clearTimeout(id) {
			clearTimeout(pendingTimers.get(id));
			pendingTimers.delete(id);
		},
		PerformanceObserver: options.observer ? FakeObserver : null,
		heap: () => (options.noHeap ? null : heapBytes),
		navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
			+ 'Chrome/131.0.6778.86 Safari/537.36', hardwareConcurrency: 8, deviceMemory: 8 },
		screen: { width: 1920, height: 1080 },
		devicePixelRatio: 1.25,
		innerWidth: 1536,
		innerHeight: 730,
		mode: () => options.mode || 'select',
		analysisCenter: () => options.analysisCenter || null,
		buildings3d: () => (options.buildings3d === undefined ? true : options.buildings3d),
		mapElement: () => options.element || null,
		console: { info() {}, warn() {}, table() {} }
	};
	return { env, record, map, existing, pending: () => pendingRaf.size + pendingTimers.size };
}

const quick = { counts: [10, 25], methods: ['A', 'D'], repeats: 1, chunkSize: 10, idleSampleMs: 5, cameraStepMs: 5,
	memoryCycles: 3, center: CENTER };

function drain() {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/* ---------- cells ---------- */

test('synthetic grids have the requested number of cells, nearest first, unique', () => {
	for (const count of bench.COUNTS) {
		const cells = bench.syntheticCells(count, CENTER, 50, 0.02);
		assert.equal(cells.length, count);
		assert.equal(new Set(cells.map((c) => c.id)).size, count);
		assert.equal(cells[0].id, '0:0');
		const d = cells.map((c) => c.col * c.col + c.row * c.row);  // exact integers (Math.hypot differs by 1 ulp for ties)
		assert.ok(d.every((v, i) => i === 0 || v >= d[i - 1]), 'ordered by distance from the center');
		assert.ok(cells.every((c) => c.ring.length === 4 && c.empty === false));
	}
	assert.deepEqual(bench.syntheticCells(0, CENTER, 50), []);
	assert.throws(() => bench.syntheticCells(10, null, 50), /center/);
	assert.deepEqual(bench.COUNTS, [100, 300, 500, 1000, 1345]);
});

test('1,345 cells cover about the 1 km circle (the 50 m grid of a 1 km analysis)', () => {
	const cells = bench.syntheticCells(1345, CENTER, 50, 0);
	const farthest = Math.max(...cells.map((c) => Math.hypot(c.col, c.row) * 50));
	assert.ok(farthest > 1000 && farthest < 1100, String(farthest));
});

test('cell coordinates: 50 m squares on the local tangent plane, cell (0,0) centered on the analysis center', () => {
	const scale = bench.metersPerDegree(CENTER.lat);
	const cells = bench.syntheticCells(9, CENTER, 50, 0);
	const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
	const toMeters = ([lon, lat]) => [(lon - CENTER.lon) * scale.lon, (lat - CENTER.lat) * scale.lat];

	assert.deepEqual(byId['0:0'].center, [CENTER.lon, CENTER.lat]);
	const ring = byId['0:0'].ring.map(toMeters);
	assert.deepEqual(ring.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [[-25, -25], [25, -25], [25, 25], [-25, 25]]);
	const east = toMeters(byId['1:0'].center);
	assert.ok(Math.abs(east[0] - 50) < 1e-6 && Math.abs(east[1]) < 1e-6);
	const north = toMeters(byId['0:1'].center);
	assert.ok(Math.abs(north[1] - 50) < 1e-6);
	// Same WGS84 radii as the Java/Python projection: about 88.3 km per degree of longitude at 37.57°N.
	assert.ok(Math.abs(scale.lon - 88347) < 5 && Math.abs(scale.lat - 110988) < 5);
	// The 2% inset leaves a gap between neighbouring cells (no outlines on ground polygons).
	const inset = bench.syntheticCells(1, CENTER, 50, 0.02)[0].ring.map(toMeters);
	assert.ok(Math.abs(inset[1][0] - inset[0][0] - 49) < 1e-6);
});

test('grid-density responses become cells, optionally without empty ones', () => {
	const feature = (id, buildings, primary) => ({ type: 'Feature', id,
		geometry: { type: 'Polygon', coordinates: [[[127, 37.5], [127.001, 37.5], [127.001, 37.501], [127, 37.501], [127, 37.5]]] },
		properties: { col: 0, row: 0, centerLon: 127.0005, centerLat: 37.5005, buildingCount: buildings,
			primaryBuildingCount: primary } });
	const body = { analysisIds: [], result: { cells: { type: 'FeatureCollection',
		features: [feature('0:0', 2, 1), feature('1:0', 0, 0), feature('2:0', 0, 1)] } } };

	const all = bench.cellsFromGridDensity(body);
	assert.equal(all.length, 3);
	assert.equal(all[0].ring.length, 4);  // closing point removed
	assert.deepEqual(all.map((c) => c.empty), [false, true, false]);
	assert.deepEqual(bench.cellsFromGridDensity(body.result, { excludeEmpty: true }).map((c) => c.id), ['0:0', '2:0']);
	assert.throws(() => bench.cellsFromGridDensity({ result: {} }), /cells\.features/);
});

/* ---------- statistics ---------- */

test('summary statistics and nearest-rank percentiles', () => {
	const values = Array.from({ length: 100 }, (_, i) => i + 1);
	assert.deepEqual(bench.summarize(values), { count: 100, min: 1, max: 100, mean: 50.5, p50: 50, p95: 95 });
	assert.deepEqual(bench.summarize([]), { count: 0, min: null, max: null, mean: null, p50: null, p95: null });
	assert.equal(bench.summarize([NaN, 5, Infinity]).count, 1);
});

test('frame statistics count frames over 50 ms', () => {
	const stats = bench.frameStats([16, 16, 17, 60, 120, 16]);
	assert.equal(stats.frames, 6);
	assert.equal(stats.overThreshold, 2);
	assert.equal(stats.p50, 16);
	assert.equal(stats.p95, 120);
	assert.equal(stats.max, 120);
	assert.equal(stats.fps, 24.5);  // mean interval 40.83 ms
	assert.deepEqual(bench.frameStats([]), { frames: 0, p50: null, p95: null, max: null, overThreshold: null,
		thresholdMs: 50, fps: null });
});

test('memory trend is reported as measured values only', () => {
	const growing = bench.memoryTrend([100, 110, 120, 130]);
	assert.equal(growing.slopeBytesPerCycle, 10);
	assert.equal(growing.increasingSteps, 3);
	assert.equal(growing.firstToLastBytes, 30);
	const flat = bench.memoryTrend([100, 100, 100]);
	assert.equal(flat.slopeBytesPerCycle, 0);
	assert.equal(flat.increasingSteps, 0);
	assert.equal(bench.memoryTrend([100]).slopeBytesPerCycle, null);
	assert.equal(bench.memoryTrend([]).increasingSteps, null);
});

test('environment: browser, OS, screen and the 3D building layer', () => {
	const { env } = fakeEnv();
	const info = bench.environment(env);
	assert.deepEqual(info.browser, { name: 'Chrome', version: '131.0.6778.86' });
	assert.equal(info.os, 'Windows NT 10.0');
	assert.deepEqual(info.screen, { width: 1920, height: 1080, devicePixelRatio: 1.25 });
	assert.deepEqual(info.viewport, { width: 1536, height: 730 });
	assert.equal(info.buildings3d, true);
	const edge = bench.environment({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36 Edg/131.0.2903.70' } });
	assert.deepEqual(edge.browser, { name: 'Edge', version: '131.0.2903.70' });
	const unknown = bench.environment({});
	assert.deepEqual(unknown.browser, { name: null, version: null });
	assert.equal(unknown.os, null);
	assert.equal(unknown.buildings3d, null);
});

/* ---------- run ---------- */

test('a run measures every count and method and leaves nothing behind', async () => {
	const { env, record, existing, pending } = fakeEnv({ observer: true });
	const b = bench.createBench(env);
	const result = await b.run(quick);

	assert.equal(result.status, 'completed');
	assert.equal(result.error, null);
	assert.deepEqual(result.runs.map((r) => [r.cells, r.method]), [[10, 'A'], [10, 'D'], [25, 'A'], [25, 'D']]);
	for (const run of result.runs) {
		assert.equal(run.create.created, run.cells);
		assert.equal(run.create.errors, 0);
		assert.equal(typeof run.create.ms, 'number');
		assert.equal(typeof run.restoreMs, 'number');
		assert.equal(typeof run.deleteMs, 'number');
		assert.equal(run.deleteFailures, 0);
		assert.equal(typeof run.firstFrameMs, 'number');
		assert.ok(run.framesIdle.frames > 0);
		assert.ok(run.framesCamera.frames > 0);
		assert.equal(run.longTasks.type, 'longtask');
		assert.equal(run.longTasks.maxMs, 120);
		assert.equal(typeof run.heap.before, 'number');
		assert.equal(run.cancelled, false);
	}
	assert.equal(result.runs[1].create.chunks, 1);
	assert.equal(result.runs[3].create.chunks, 3);  // 25 cells in chunks of 10
	assert.equal(result.summary.length, 4);
	assert.equal(result.memoryTrend.supported, true);
	assert.equal(result.memoryTrend.cycles, 3);
	assert.equal(result.memoryTrend.cells, 25);
	assert.equal(result.environment.browser.name, 'Chrome');
	assert.equal(result.options.centerSource, 'option');
	assert.ok(result.limits.length >= 5);
	assert.doesNotThrow(() => JSON.parse(b.json()));

	// Only its own polygons were created and removed; the map's other objects and map.clear() were never touched.
	assert.equal(record.removed.length, record.created.length);
	assert.ok(record.created.every((obj) => record.removed.includes(obj)));
	assert.equal(record.clearCalls, 0);
	assert.ok(existing.every((obj) => !record.removed.includes(obj)));
	assert.ok(record.moves > 0);
	assert.ok(record.observers.every((o) => o.disconnected));
	assert.deepEqual(b.status(), { running: false, cancelRequested: false, objects: 0, observers: 0, listeners: 0 });
	await drain();
	assert.equal(pending(), 0);
});

test('a second run while one is running is refused', async () => {
	const { env } = fakeEnv();
	const b = bench.createBench(env);
	const first = b.run(quick);

	await assert.rejects(b.run(quick), /ALREADY_RUNNING/);
	await assert.rejects(b.measureClicks(), /ALREADY_RUNNING/);
	const result = await first;
	assert.equal(result.status, 'completed');
	const again = await b.run({ ...quick, counts: [5], methods: ['A'], memoryCycles: 0 });
	assert.equal(again.status, 'completed');
});

test('cancel stops the run and removes every created polygon', async () => {
	const { env, record, pending } = fakeEnv();
	const b = bench.createBench(env);
	const running = b.run({ ...quick, counts: [100, 300, 500], repeats: 2 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(b.cancel(), true);
	const result = await running;

	assert.equal(result.status, 'cancelled');
	assert.ok(result.runs.length < 12);
	assert.equal(record.removed.length, record.created.length);
	assert.equal(record.clearCalls, 0);
	assert.equal(b.status().objects, 0);
	assert.equal(b.cancel(), false);  // nothing to cancel any more
	await drain();
	assert.equal(pending(), 0);
});

test('cleanup can be called any time, also during a run, and twice', async () => {
	const { env, record } = fakeEnv();
	const b = bench.createBench(env);
	const running = b.run({ ...quick, counts: [300], methods: ['D'], chunkSize: 50 });
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	const report = b.cleanup();
	assert.equal(report.objects, 0);
	const result = await running;

	assert.equal(result.status, 'cancelled');
	assert.equal(record.removed.length, record.created.length);
	assert.deepEqual(b.cleanup(), { removedFailures: 0, objects: 0, observers: 0, listeners: 0, frames: 0, timers: 0 });
});

for (const stop of ['cancel', 'cleanup']) {
	test(stop + ' still finishes when frames stop arriving (background tab)', async () => {
		const { env, record, pending } = fakeEnv({ rafNeverFires: true });
		const b = bench.createBench(env);
		const running = b.run({ ...quick, warmup: false });
		await drain();
		assert.equal(b.status().running, true);  // stuck waiting for a frame
		b[stop]();
		const result = await running;

		assert.equal(result.status, 'cancelled');
		assert.equal(record.removed.length, record.created.length);
		assert.equal(b.status().objects, 0);
		assert.equal(pending(), 0);
	});
}

test('failed cell creations are counted and partly created cells are removed', async () => {
	const { env, record } = fakeEnv({ failEvery: 4 });
	const b = bench.createBench(env);
	const result = await b.run({ ...quick, counts: [20], methods: ['A'], memoryCycles: 0, warmup: false });

	assert.equal(result.status, 'completed');
	assert.equal(result.runs[0].create.errors, 5);
	assert.equal(result.runs[0].create.created, 15);
	assert.equal(record.failedCreates > 0, true);
	assert.equal(b.status().objects, 0);
	assert.equal(record.clearCalls, 0);
});

test('removal errors are reported, not hidden', async () => {
	const { env } = fakeEnv({ removeThrows: true });
	const b = bench.createBench(env);
	const result = await b.run({ ...quick, counts: [5], methods: ['A'], memoryCycles: 0, warmup: false });

	assert.equal(result.runs[0].deleteFailures, 5);
	assert.equal(b.status().objects, 0);  // the tool forgets them either way; nothing is retried with map.clear()
});

test('an unexpected error fails the run and still cleans up', async () => {
	const { env, record, pending } = fakeEnv({ rafThrowsAfter: 6 });
	const b = bench.createBench(env);
	const result = await b.run({ ...quick, warmup: false });

	assert.equal(result.status, 'failed');
	assert.match(result.error, /raf failed/);
	assert.equal(record.removed.length, record.created.length);
	assert.equal(b.status().running, false);
	assert.equal(b.status().objects, 0);
	await drain();
	assert.equal(pending(), 0);
});

test('the map and VWorld must be ready; unknown methods are refused', async () => {
	await assert.rejects(bench.createBench(fakeEnv({ noVw: true }).env).run(quick), /vw\.geom\.PolygonZ/);
	await assert.rejects(bench.createBench(fakeEnv({ noMap: true }).env).run(quick), /window\.gisMap/);
	await assert.rejects(bench.createBench(fakeEnv().env).run({ ...quick, methods: ['B'] }), /지원하지 않는 방식/);
});

test('unsupported measurements are null, not estimates', async () => {
	const { env } = fakeEnv({ noHeap: true });
	const result = await bench.createBench(env).run({ ...quick, counts: [5], methods: ['A'], camera: false });

	assert.equal(result.runs[0].heap.before, null);
	assert.equal(result.runs[0].heap.afterCreate, null);
	assert.equal(result.runs[0].longTasks, null);       // no PerformanceObserver
	assert.equal(result.runs[0].framesCamera, null);    // camera test off
	assert.equal(result.memoryTrend.supported, false);
	assert.equal(result.summary[0].cameraP95Median, null);
});

test('the analysis center is used when there is one, otherwise the default', async () => {
	const fromAnalysis = await bench.createBench(fakeEnv({ analysisCenter: { lon: 127.1, lat: 37.4 } }).env)
		.run({ ...quick, center: undefined, counts: [3], methods: ['A'], memoryCycles: 0 });
	assert.equal(fromAnalysis.options.centerSource, 'analysis');
	assert.deepEqual(fromAnalysis.options.center, { lon: 127.1, lat: 37.4 });
	const fallback = await bench.createBench(fakeEnv().env)
		.run({ ...quick, center: undefined, counts: [3], methods: ['A'], memoryCycles: 0 });
	assert.equal(fallback.options.centerSource, 'default');
	assert.deepEqual(fallback.options.center, bench.DEFAULT_CENTER);
});

test('real grid-density cells can be benchmarked instead of synthetic ones', async () => {
	const cells = bench.syntheticCells(30, CENTER, 50, 0).map((c, i) => ({ ...c, empty: i % 2 === 1 }));
	const result = await bench.createBench(fakeEnv().env)
		.run({ ...quick, cells: cells.filter((c) => !c.empty), counts: [100], methods: ['A'], memoryCycles: 0 });
	assert.equal(result.options.cellSource, 'grid-density');
	assert.equal(result.runs[0].create.created, 15);
});

/* ---------- clicks ---------- */

function fakeElement() {
	const listeners = [];
	return {
		listeners,
		addEventListener(type, fn, capture) {
			listeners.push({ type, fn, capture });
		},
		removeEventListener(type, fn, capture) {
			const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
			if (i >= 0) {
				listeners.splice(i, 1);
			}
		},
		down() {
			listeners.filter((l) => l.type === 'pointerdown').forEach((l) => l.fn({}));
		}
	};
}

test('click latency: pointerdown to the polygon callback, then everything is removed', async () => {
	const element = fakeElement();
	const { env, record } = fakeEnv({ element });
	const b = bench.createBench(env);
	const measuring = b.measureClicks({ cells: 20, samples: 3, timeoutMs: 5000, center: CENTER });
	assert.equal(element.listeners.length, 1);
	for (let i = 0; i < 3; i++) {
		element.down();
		record.created[i].listener();  // the engine calls the polygon listener after the pointer event
	}
	const result = await measuring;

	assert.equal(result.kind, 'click');
	assert.equal(result.status, 'completed');
	assert.equal(result.clicks.stats.count, 3);
	assert.ok(result.clicks.samplesMs.every((ms) => ms >= 0));
	assert.equal(element.listeners.length, 0);  // no DOM listener left
	assert.ok(record.created.every((obj) => obj.listenerRemoved));
	assert.equal(record.removed.length, record.created.length);
	assert.equal(record.clearCalls, 0);
});

test('click measurement is refused in radius mode and can be cancelled', async () => {
	await assert.rejects(bench.createBench(fakeEnv({ mode: 'radius' }).env).measureClicks(), /반경 분석 모드/);

	const element = fakeElement();
	const { env, record } = fakeEnv({ element });
	const b = bench.createBench(env);
	const measuring = b.measureClicks({ cells: 10, samples: 5, center: CENTER });
	b.cancel();
	const result = await measuring;
	assert.equal(result.status, 'cancelled');
	assert.equal(result.clicks.stats.count, 0);
	assert.equal(element.listeners.length, 0);
	assert.equal(record.removed.length, record.created.length);
});

/* ---------- browser loading ---------- */

test('pasting the file in a page defines window.gridBench, and pasting again cleans up the old one', () => {
	const removed = [];
	const window = {
		console: { info() {}, warn() {}, table() {} },
		performance: { now: () => 0 },
		requestAnimationFrame: () => 1,
		cancelAnimationFrame() {},
		setTimeout: () => 1,
		clearTimeout() {},
		navigator: { userAgent: '' },
		screen: {},
		document: { getElementById: () => null, querySelector: () => null },
		gisMap: { removeObject: (o) => removed.push(o), clear() { throw new Error('map.clear must never be called'); } }
	};
	window.window = window;
	const source = fs.readFileSync(SOURCE, 'utf8');
	const context = vm.createContext(window);
	vm.runInContext(source, context);
	const first = window.gridBench;
	assert.equal(typeof first.run, 'function');
	assert.equal(typeof first.cleanup, 'function');
	assert.equal(first.probe(), null);  // no vw on this page

	vm.runInContext(source, context);
	assert.notEqual(window.gridBench, first);
	assert.equal(first.status().objects, 0);
});

test('the tool does not call map.clear, send data anywhere or use VWorld/Cesium internals', () => {
	const source = fs.readFileSync(SOURCE, 'utf8')
		.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');  // code only, not comments
	assert.doesNotMatch(source, /\.clear\(\)/);
	assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|navigator\.clipboard/);
	assert.doesNotMatch(source, /ws3d|Cesium|objectManager|_options/);
});
