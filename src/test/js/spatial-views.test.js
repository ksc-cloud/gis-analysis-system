// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
// spatial-views.js: switching the views of the spatial analysis tab (stats / grid / compare), on its own.
// The pure parts are required directly; start() runs in a vm sandbox with a strict mini DOM where
// getElementById() returns null for elements the page does not have.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS = path.join(__dirname, '../../main/resources/static/js');
const JSP = path.join(__dirname, '../../main/webapp/WEB-INF/views/index.jsp');
const views = require(path.join(JS, 'spatial-views.js'));

class MiniElement {
	constructor(id) {
		this.id = id;
		this.hidden = false;
		this.attributes = {};
		this.listeners = {};
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

	click() {
		(this.listeners.click || []).forEach((fn) => fn({}));
	}
}

/** names: the views the page has (panel + button), as index.jsp renders them: only stats visible. */
function page(names = ['stats', 'grid', 'compare']) {
	const elements = {};
	names.forEach((name) => {
		const panel = new MiniElement('spatial-view-' + name);
		panel.hidden = name !== 'stats';
		const button = new MiniElement('spatial-view-button-' + name);
		button.setAttribute('data-view', name);
		button.setAttribute('aria-pressed', String(name === 'stats'));
		elements[panel.id] = panel;
		elements[button.id] = button;
	});
	const events = [];
	const document = {
		getElementById: (id) => elements[id] || null,
		dispatchEvent: (event) => events.push({ type: event.type, view: event.detail.view })
	};
	const window = { document, CustomEvent, console };
	window.window = window;
	vm.runInContext(fs.readFileSync(path.join(JS, 'spatial-views.js'), 'utf8'), vm.createContext(window),
		{ filename: 'spatial-views.js' });
	return {
		window,
		events,
		el: (id) => elements[id],
		visible: () => names.filter((name) => !elements['spatial-view-' + name].hidden),
		pressed: () => names.filter((name) => elements['spatial-view-button-' + name].getAttribute('aria-pressed') === 'true')
	};
}

/* ---------- pure ---------- */

test('resolveView: a view the page has is kept, anything else falls back to stats', () => {
	const available = ['stats', 'grid', 'compare'];
	assert.equal(views.DEFAULT_VIEW, 'stats');
	assert.equal(views.resolveView('grid', available), 'grid');
	assert.equal(views.resolveView('compare', available), 'compare');
	assert.equal(views.resolveView('stats', available), 'stats');
	['hotspot', '', null, undefined, 3, 'GRID', 'toString', 'constructor'].forEach((name) => {
		assert.equal(views.resolveView(name, available), 'stats', String(name));
	});
	assert.equal(views.resolveView('grid', ['stats', 'compare']), 'stats');  // no grid panel on the page
});

test('VIEWS lists the views in the order of the buttons', () => {
	assert.deepEqual([...views.VIEWS], ['stats', 'grid', 'compare']);
});

/* ---------- start() ---------- */

test('start: installs window.gisSpatialViews and sends no event while starting', () => {
	const p = page();
	assert.equal(typeof p.window.gisSpatialViews.show, 'function');
	assert.equal(typeof p.window.gisSpatialViews.current, 'function');
	assert.equal(p.window.gisSpatialViews.current(), 'stats');
	assert.deepEqual(p.events, []);
	assert.deepEqual(p.visible(), ['stats']);  // the markup is not touched before the first switch
	assert.deepEqual(p.pressed(), ['stats']);
});

test('show: only the chosen panel is visible, only its button is pressed, one event with the view', () => {
	const p = page();
	['grid', 'compare', 'stats'].forEach((name, i) => {
		p.window.gisSpatialViews.show(name);
		assert.equal(p.window.gisSpatialViews.current(), name);
		assert.deepEqual(p.visible(), [name]);
		assert.deepEqual(p.pressed(), [name]);
		assert.equal(p.events.length, i + 1);
		assert.deepEqual(p.events[i], { type: 'gis:spatialviewchange', view: name });
	});
});

test('show: choosing the current view again sends the event again', () => {
	const p = page();
	p.window.gisSpatialViews.show('grid');
	p.window.gisSpatialViews.show('grid');
	assert.deepEqual(p.events.map((e) => e.view), ['grid', 'grid']);
	assert.deepEqual(p.visible(), ['grid']);
});

test('show: an unknown view shows stats and reports stats', () => {
	const p = page();
	p.window.gisSpatialViews.show('compare');
	p.window.gisSpatialViews.show('hotspot');
	assert.equal(p.window.gisSpatialViews.current(), 'stats');
	assert.deepEqual(p.visible(), ['stats']);
	assert.deepEqual(p.pressed(), ['stats']);
	assert.deepEqual(p.events.map((e) => e.view), ['compare', 'stats']);
});

test('show: a view whose panel is not on the page falls back to stats', () => {
	const p = page(['stats', 'compare']);
	p.window.gisSpatialViews.show('grid');
	assert.equal(p.window.gisSpatialViews.current(), 'stats');
	assert.deepEqual(p.visible(), ['stats']);
	assert.deepEqual(p.events.map((e) => e.view), ['stats']);
});

test('buttons: one click switches the view and sends exactly one event', () => {
	const p = page();
	p.el('spatial-view-button-grid').click();
	assert.deepEqual(p.visible(), ['grid']);
	assert.deepEqual(p.pressed(), ['grid']);
	assert.deepEqual(p.events.map((e) => e.view), ['grid']);
	p.el('spatial-view-button-compare').click();
	p.el('spatial-view-button-stats').click();
	assert.deepEqual(p.events.map((e) => e.view), ['grid', 'compare', 'stats']);
	assert.deepEqual(p.visible(), ['stats']);
});

test('works without the compare module (spatial-compare.js not loaded)', () => {
	const p = page();
	assert.equal(p.window.gisCompare, undefined);
	p.el('spatial-view-button-compare').click();
	assert.deepEqual(p.visible(), ['compare']);
	p.window.gisSpatialViews.show('grid');
	assert.deepEqual(p.visible(), ['grid']);
});

test('a page without any spatial view does not install the module', () => {
	const p = page([]);
	assert.equal(p.window.gisSpatialViews, undefined);
});

/* ---------- index.jsp ---------- */

test('index.jsp loads spatial-views.js before the dashboard, compare and grid modules', () => {
	const jsp = fs.readFileSync(JSP, 'utf8');
	const at = (file) => jsp.indexOf('/js/' + file + '"');
	assert.ok(at('spatial-views.js') > 0, 'spatial-views.js is loaded');
	['spatial-dashboard.js', 'spatial-compare.js', 'spatial-grid.js'].forEach((file) => {
		assert.ok(at(file) > 0, file + ' is loaded');
		assert.ok(at('spatial-views.js') < at(file), 'spatial-views.js before ' + file);
	});
	assert.equal(jsp.split('/js/spatial-views.js"').length, 2, 'loaded once');
});

test('index.jsp keeps the view buttons and panels the module looks up', () => {
	const jsp = fs.readFileSync(JSP, 'utf8');
	views.VIEWS.forEach((name) => {
		assert.match(jsp, new RegExp('id="spatial-view-button-' + name + '" data-view="' + name + '"'));
		assert.match(jsp, new RegExp('aria-controls="spatial-view-' + name + '"'));
		assert.match(jsp, new RegExp('id="spatial-view-' + name + '"'));
	});
});
