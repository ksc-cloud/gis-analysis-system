// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// The two additions to the existing map modules for the grid (8-6B-2c), loaded unchanged in a vm sandbox:
//   map-analysis-renderer.js setBuildingsVisible()  and  map-analysis.js gisAnalysis.suppressNextMapClick()
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');

function fakeVWorld() {
	const record = { created: [], removed: [] };
	class Shape {
		constructor(kind) {
			this.kind = kind;
		}

		setFillColor() {}

		setOutLineVisible() {}

		setName() {}

		setFont() {}

		setFontSize() {}

		create() {
			record.created.push(this);
		}

		addEventListener(fn) {
			this.listener = fn;
		}

		removeEventListener() {
			this.listener = null;
		}
	}
	const vw = {
		geom: {
			CircleZ: class extends Shape { constructor() { super('circle'); } },
			PointZ: class extends Shape { constructor() { super('marker'); } },
			PolygonZ: class extends Shape { constructor() { super('building'); } }
		},
		Collection: class { constructor(items) { this.items = items; } },
		Coord: class { constructor(x, y) { this.v = [x, y]; } },
		CoordZ: class { constructor(x, y, z) { this.v = [x, y, z]; } },
		Color: class {}
	};
	const map = { removeObject: (o) => record.removed.push(o) };
	return { vw, map, record };
}

function loadRenderer() {
	const fake = fakeVWorld();
	const window = { vw: fake.vw, console };
	window.window = window;
	vm.runInContext(fs.readFileSync(path.join(JS, 'map-analysis-renderer.js'), 'utf8'), vm.createContext(window));
	const renderer = window.gisAnalysisRenderer;
	renderer.setMap(fake.map);
	return { renderer, ...fake };
}

const CENTER = { lon: 127, lat: 37.5 };
const ring = (x) => [[[x, 37.5], [x + 0.0001, 37.5], [x + 0.0001, 37.5001], [x, 37.5]]];
const BUILDINGS = [{ id: 'bd:1', relation: 'INSIDE', polygons: [ring(127)] },
	{ id: 'bd:2', relation: 'PARTIAL', polygons: [ring(127.001)] }];

const live = (record) => record.created.filter((o) => !record.removed.includes(o));
const kinds = (objects) => objects.map((o) => o.kind).sort();

test('analysis renderer: buildings can be hidden while the circle and the center marker stay', () => {
	const { renderer, record } = loadRenderer();
	renderer.showResult(CENTER, 100, BUILDINGS);
	assert.deepEqual(kinds(live(record)), ['building', 'building', 'circle', 'marker']);
	assert.equal(renderer.areBuildingsVisible(), true);

	renderer.setBuildingsVisible(false);
	assert.deepEqual(kinds(live(record)), ['circle', 'marker']);
	assert.equal(renderer.isDrawn('bd:1'), false);
	assert.equal(renderer.count(), 4);  // definitions kept
	renderer.setBuildingsVisible(false);  // no-op
	assert.equal(record.created.length, 4);

	renderer.setBuildingsVisible(true);
	assert.deepEqual(kinds(live(record)), ['building', 'building', 'circle', 'marker']);
	assert.equal(renderer.isDrawn('bd:1'), true);
});

test('analysis renderer: restore after a measurement reset does not bring hidden buildings back', () => {
	const { renderer, record } = loadRenderer();
	renderer.showResult(CENTER, 100, BUILDINGS);
	renderer.setBuildingsVisible(false);
	const before = record.created.length;
	renderer.restore();

	const created = record.created.slice(before);
	assert.deepEqual(kinds(created), ['circle', 'marker']);
	assert.equal(renderer.highlight('bd:1'), false);  // highlighting does not draw a hidden building either
	assert.deepEqual(kinds(live(record)), ['circle', 'marker']);
});

test('analysis renderer: a new result or clear() shows buildings again', () => {
	const { renderer, record } = loadRenderer();
	renderer.showResult(CENTER, 100, BUILDINGS);
	renderer.setBuildingsVisible(false);
	renderer.showResult(CENTER, 100, BUILDINGS);  // new analysis

	assert.equal(renderer.areBuildingsVisible(), true);
	assert.deepEqual(kinds(live(record)), ['building', 'building', 'circle', 'marker']);
});

/* ---------- map-analysis.js: click suppression ---------- */

class FakeElement {
	constructor() {
		this.hidden = false;
		this.disabled = false;
		this.className = '';
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.textContent = '';
		this.value = '';
		const self = this;
		this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
		this.style = {};
		void self;
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

	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}

	focus() {}
}

function loadAnalysis(mode) {
	const elements = {};
	const listeners = {};
	const document = {
		currentScript: { getAttribute: () => '/api/buildings/nearby' },
		getElementById: (id) => (elements[id] = elements[id] || new FakeElement()),
		querySelectorAll: () => [],
		createElement: () => new FakeElement(),
		addEventListener: (type, fn) => {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		dispatchEvent: (event) => (listeners[event.type] || []).forEach((fn) => fn(event))
	};
	const window = { document, console, CustomEvent, gisTools: { getMode: () => mode, setMode() {} } };
	window.window = window;
	vm.runInContext(fs.readFileSync(path.join(JS, 'map-analysis.js'), 'utf8'), vm.createContext(window));
	let mapClick = null;
	const map = { onClick: { addEventListener: (fn) => { mapClick = fn; } } };
	document.dispatchEvent(new CustomEvent('gis:mapready', { detail: { map } }));
	const click = (lon, lat) => mapClick(null, null, { longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180 });
	return { analysis: window.gisAnalysis, click };
}

test('map-analysis: a suppressed click does not move the radius center, the next one does', () => {
	const { analysis, click } = loadAnalysis('radius');
	assert.equal(typeof analysis.suppressNextMapClick, 'function');

	analysis.suppressNextMapClick();  // e.g. a grid cell was clicked
	click(127.001, 37.501);
	assert.equal(analysis.getState().center, null);

	click(127.002, 37.502);
	assert.deepEqual({ ...analysis.getState().center }, { lon: 127.002, lat: 37.502 });
});

test('map-analysis: without suppression a radius-mode click sets the center', () => {
	const { analysis, click } = loadAnalysis('radius');
	click(127.003, 37.503);
	assert.deepEqual({ ...analysis.getState().center }, { lon: 127.003, lat: 37.503 });
});
