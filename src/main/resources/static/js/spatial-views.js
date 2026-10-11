/*
 * GIS 3D 지도 - 공간 분석 탭의 보기 전환 (8-7-0, 통계 / 격자 / 핫스팟 / 비교)
 *
 * - 보기마다 패널(id="spatial-view-{name}")과 버튼(id="spatial-view-button-{name}", data-view)이 있다.
 *   페이지에 패널이 있는 보기만 열 수 있고, 알 수 없거나 없는 보기는 통계(stats)로 연다.
 * - 보기를 열면 그 패널만 보이고(hidden) 그 버튼만 눌린 상태(aria-pressed)가 되며, 같은 보기를 다시 열어도
 *   'gis:spatialviewchange' { view }를 보낸다. 시작할 때는 보내지 않는다(처음 화면은 index.jsp의 hidden이 정한다).
 * - 다른 파일은 window.gisSpatialViews.show(name), current()로 보기를 바꾸고 확인한다.
 *   보기의 내용은 spatial-dashboard.js(통계), spatial-grid.js(격자), spatial-hotspot.js(핫스팟),
 *   spatial-compare.js(비교)가 그린다.
 * - 보기 판정과 전환은 DOM 없이 동작해 node --test로 검사한다.
 */
(function (factory) {
	'use strict';
	var views = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = views;
	} else {
		views.start(document, window);
	}
})(function () {
	'use strict';

	var VIEWS = ['stats', 'grid', 'hotspot', 'compare'];
	var DEFAULT_VIEW = 'stats';

	/* 열 수 있는 보기면 그 이름, 아니면 통계 */
	function resolveView(name, available) {
		return typeof name === 'string' && available.indexOf(name) !== -1 ? name : DEFAULT_VIEW;
	}

	/*
	 * options.views: [{ name, panel, button }] (panel, button은 없을 수 있다)
	 * options.dispatch(view): 보기를 바꿀 때마다 부른다.
	 */
	function createSwitcher(options) {
		var entries = options.views;
		var available = entries.filter(function (entry) {
			return !!entry.panel;
		}).map(function (entry) {
			return entry.name;
		});
		var current = DEFAULT_VIEW;

		function show(name) {
			current = resolveView(name, available);
			entries.forEach(function (entry) {
				if (entry.panel) {
					entry.panel.hidden = entry.name !== current;
				}
				if (entry.button) {
					entry.button.setAttribute('aria-pressed', String(entry.button.getAttribute('data-view') === current));
				}
			});
			options.dispatch(current);
			return current;
		}

		return {
			show: show,
			current: function () {
				return current;
			}
		};
	}

	/* ---------- 화면 (브라우저) ---------- */

	function start(doc, win) {
		var entries = VIEWS.map(function (name) {
			return {
				name: name,
				panel: doc.getElementById('spatial-view-' + name),
				button: doc.getElementById('spatial-view-button-' + name)
			};
		});
		if (!entries.some(function (entry) {
			return !!entry.panel;
		})) {
			return;
		}
		var switcher = createSwitcher({
			views: entries,
			dispatch: function (view) {
				doc.dispatchEvent(new win.CustomEvent('gis:spatialviewchange', { detail: { view: view } }));
			}
		});
		entries.forEach(function (entry) {
			if (entry.button) {
				entry.button.addEventListener('click', function () {
					switcher.show(entry.button.getAttribute('data-view'));
				});
			}
		});

		win.gisSpatialViews = {
			show: switcher.show,
			current: switcher.current
		};
	}

	return {
		VIEWS: VIEWS,
		DEFAULT_VIEW: DEFAULT_VIEW,
		resolveView: resolveView,
		createSwitcher: createSwitcher,
		start: start
	};
});
