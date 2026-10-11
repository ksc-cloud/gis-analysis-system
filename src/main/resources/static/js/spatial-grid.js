/*
 * GIS 3D 지도 - 격자 밀집도 화면 (8-6B-2c, 정보 패널 "공간 분석" 탭의 "격자" 보기)
 *
 * - 지금 화면의 분석('gis:analysisresult')의 격자 밀집도를 요청해 spatial-grid-renderer.js로 지도에 그린다.
 *     저장 전 분석: GET /api/analysis-snapshots/{token}/grid-density
 *     저장된 분석: GET /api/analyses/{id}/grid-density
 *   항상 includeEmptyCells=true, includeBuildingIds=false로 받고 빈 격자는 화면에서 거른다.
 * - 요청: 같은 분석·셀 크기는 다시 요청하지 않고(현재 분석에 한해 셀 크기별 응답 최대 3개 캐시), AbortController +
 *   요청 번호 + 분석 키로 늦은 응답을 무시한다. 저장('gis:analysissaved')하면 같은 분석이므로 그린 격자와 캐시는
 *   두고 이후 요청만 저장된 분석 ID로 한다. 분석이 바뀌거나 초기화되면 요청·캐시·도형을 모두 정리하고 표시를 끈다.
 * - 응답은 cells.features 수와 grid.returnedCellCount, 셀 크기가 맞는지 확인한다. 올바르지 않은 셀을 빼거나
 *   표시 상한(1,345개)을 넘으면 몇 개를 뺐는지 안내한다.
 * - 격자를 켜면 분석 건물 도형만 숨기고(map-analysis-renderer.js setBuildingsVisible) 반경 원과 중심점은 둔다.
 *   끄면 다시 보인다. 3D 건물 레이어는 바꾸지 않는다. 다른 공간 분석 보기로 옮겨도 격자는 그대로 둔다.
 * - 격자와 핫스팟(spatial-hotspot.js)은 지도에 함께 그리지 않는다. 격자를 켜면 'gis:spatiallayerchange' { layer: 'grid' }를
 *   먼저 보내 핫스팟을 끄고, 다른 레이어가 켜졌다는 이벤트를 받으면 격자를 끈다(이때는 이벤트를 보내지 않는다).
 * - 측정 초기화('gis:measurereset', vw.Map.clear)로 지워지면 격자를 켠 상태에서만 다시 그린다. map.clear()는 쓰지 않는다.
 * - 셀을 클릭하면 반경 중심점이 바뀌지 않게 막고(gisAnalysis.suppressNextMapClick) 셀 정보를 보여 준다. 거리·면적 측정,
 *   좌표 조회 중에는 셀 클릭을 무시한다. 건물 선택 모드에서 셀을 클릭하면 건물 선택이 풀리는 기존 동작은 그대로다.
 * - 외부 값은 textContent로만 넣는다. 상태 관리와 화면 값은 DOM 없이 동작해 node --test로 검사한다.
 */
(function (factory) {
	'use strict';
	var grid = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = grid;
	} else {
		grid.start(document, window);
	}
})(function () {
	'use strict';

	var DEFAULT_CELL_SIZE = 100;
	var MAX_CACHE = 3;
	var MEASURE_MODES = ['distance', 'area', 'coord'];

	var INTEGRITY_MESSAGE = '격자 응답의 형식이나 셀 수가 맞지 않아 표시하지 않았습니다. 다시 시도하세요.';

	function isObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	/* ---------- 응답 검사와 화면 값 (순수 함수) ---------- */

	/*
	 * Java 응답 { result } → { ok: true, result } 또는 { ok: false, reason }
	 * cells.features 수와 grid.returnedCellCount가 같고 셀 크기가 요청과 같아야 한다.
	 */
	function validateResponse(body, cellSize) {
		var result = isObject(body) ? body.result : null;
		if (!isObject(result) || !isObject(result.cells) || result.cells.type !== 'FeatureCollection'
				|| !Array.isArray(result.cells.features) || !isObject(result.grid)) {
			return { ok: false, reason: 'structure' };
		}
		if (result.grid.returnedCellCount !== result.cells.features.length) {
			return { ok: false, reason: 'count' };
		}
		if (cellSize != null && result.cellSizeMeters !== cellSize) {
			return { ok: false, reason: 'cellSize' };
		}
		return { ok: true, result: result };
	}

	/* 셀 상세 표시용 속성만 원시 값으로 모은다. { id: properties } */
	function indexCells(result) {
		var index = {};
		result.cells.features.forEach(function (feature) {
			if (!isObject(feature) || !isObject(feature.properties)) {
				return;
			}
			var p = feature.properties;
			index[String(feature.id)] = {
				col: p.col, row: p.row, buildingCount: p.buildingCount, primaryBuildingCount: p.primaryBuildingCount,
				occupiedArea: p.occupiedArea, coveragePercent: p.coveragePercent, domainArea: p.domainArea,
				domainRatio: p.domainRatio, boundary: p.boundary === true, smallBoundary: p.smallBoundary === true
			};
		});
		return index;
	}

	/* 셀 상세 → { title, rows: [{ label, value }], notes: [] } */
	function cellDetail(id, props, cellSize, api) {
		var p = props || {};
		var notes = [];
		if (p.smallBoundary) {
			notes.push('반경 원 안에 든 면적이 셀의 25% 미만이라 점유율을 다른 셀과 비교하기에 적합하지 않습니다.');
		} else if (p.boundary) {
			notes.push('반경 경계에 걸친 셀입니다. 점유율은 원 안에 든 부분의 면적을 기준으로 계산했습니다.');
		}
		return {
			id: String(id),
			title: '셀 ' + String(id) + ' (' + api.formatNumber(cellSize, 0) + 'm)',
			rows: [
				{ label: '셀 점유율', value: api.formatPercent(p.coveragePercent) },
				{ label: '건물 점유 면적', value: api.formatArea(p.occupiedArea) },
				{ label: '셀에 걸친 건물', value: api.formatCount(p.buildingCount) },
				{ label: '대표 건물', value: api.formatCount(p.primaryBuildingCount) },
				{ label: '원 안 면적', value: api.formatArea(p.domainArea)
					+ (typeof p.domainRatio === 'number' ? ' (셀의 ' + api.formatNumber(p.domainRatio * 100, 1) + '%)' : '') },
				{ label: '위치', value: '동쪽 ' + p.col + '번째, 북쪽 ' + p.row + '번째 (중심 셀 0, 0)' }
			],
			notes: notes
		};
	}

	/* 그린 결과 안내: 뺀 셀, 상한, 부분 조회 등 */
	function notices(prepared, result, api) {
		var list = [];
		if (prepared.invalid > 0) {
			list.push('좌표나 값이 올바르지 않은 셀 ' + api.formatCount(prepared.invalid) + '는 표시하지 않았습니다.');
		}
		if (prepared.truncated > 0) {
			list.push('지도 표시 상한(' + api.formatCount(prepared.maxCells) + ')을 넘어 중심에서 먼 셀 '
				+ api.formatCount(prepared.truncated) + '는 표시하지 않았습니다.');
		}
		if (prepared.shown === 0) {
			list.push(prepared.emptyExcluded > 0 ? '건물이 있는 셀이 없습니다. "빈 격자 숨기기"를 끄면 모든 셀을 볼 수 있습니다.'
				: '표시할 셀이 없습니다.');
		}
		if (result && isObject(result.completeness) && result.completeness.complete === false) {
			list.push('부분 조회 결과입니다. 관측된 건물만 집계한 격자이므로 지역 전체의 밀집도로 보지 마세요.');
		}
		return list;
	}

	function summaryText(prepared, cellSize, api) {
		return '셀 ' + api.formatNumber(cellSize, 0) + 'm · 표시 ' + api.formatCount(prepared.shown) + ' / 전체 '
			+ api.formatCount(prepared.total)
			+ (prepared.emptyExcluded > 0 ? ' · 빈 격자 ' + api.formatCount(prepared.emptyExcluded) + ' 숨김' : '');
	}

	function analysisKey(target) {
		if (!target) {
			return null;
		}
		return target.generation + ':' + (target.kind === 'saved' ? 'id:' + target.analysisId : 'token:' + target.token);
	}

	/* ---------- 상태 관리 (DOM 없음) ---------- */

	/*
	 * deps: {
	 *   api, model(prepareCells), renderer(격자 도형), analysisRenderer() (setBuildingsVisible),
	 *   analysis() (suppressNextMapClick), mode(), fetchJson(url, signal), base, online(), render(state),
	 *   refreshStatus(), openGridView(), dispatchLayer(layer) (gis:spatiallayerchange, 없어도 된다)
	 * }
	 * request.phase: idle | loading | done | error | blocked
	 * drawing.phase: none | drawing | done | cancelled | failed | unsupported
	 */
	function createController(deps) {
		var api = deps.api;
		var state = {
			target: null,
			targetKey: null,
			display: false,
			cellSize: DEFAULT_CELL_SIZE,
			excludeEmpty: true,
			service: 'checking',
			cache: [],            // [{ size, result, index }] 현재 분석만
			request: { key: null, size: null, phase: 'idle', error: null },
			drawing: { phase: 'none', created: 0, total: 0 },
			prepared: null,       // 개수 정보만 (셀은 renderer가 보관)
			notices: [],
			selected: null,
			requestCount: 0
		};
		var seq = 0;
		var controller = null;
		var drawSeq = 0;

		function render() {
			if (deps.render) {
				deps.render(state);
			}
		}

		function abort() {
			seq++;
			if (controller) {
				controller.abort();
				controller = null;
			}
		}

		function buildings(visible) {
			var r = deps.analysisRenderer ? deps.analysisRenderer() : null;
			if (r && typeof r.setBuildingsVisible === 'function') {
				r.setBuildingsVisible(visible);
			}
		}

		function clearDrawing() {
			drawSeq++;
			deps.renderer.clear();
			state.drawing = { phase: 'none', created: 0, total: 0 };
			state.prepared = null;
			state.notices = [];
			state.selected = null;
		}

		function serviceBlocked() {
			return state.service === 'unavailable' || state.service === 'not-configured';
		}

		/* 격자를 끈다: 요청 취소, 도형·리스너 정리, 분석 건물 다시 표시. 캐시는 둔다. */
		function turnOff(keepError) {
			var wasOn = state.display;
			abort();
			clearDrawing();
			state.display = false;
			if (!keepError) {
				state.request = { key: null, size: null, phase: 'idle', error: null };
			}
			if (wasOn) {
				buildings(true);
			}
		}

		function cached(size) {
			for (var i = 0; i < state.cache.length; i++) {
				if (state.cache[i].size === size) {
					return state.cache[i];
				}
			}
			return null;
		}

		function remember(size, result) {
			state.cache = state.cache.filter(function (entry) {
				return entry.size !== size;
			});
			state.cache.push({ size: size, result: result, index: indexCells(result) });
			while (state.cache.length > MAX_CACHE) {
				state.cache.shift();
			}
		}

		function draw(entry) {
			var prepared = deps.model.prepareCells(entry.result, { excludeEmpty: state.excludeEmpty });
			var mySeq = ++drawSeq;
			state.prepared = { total: prepared.total, invalid: prepared.invalid, emptyExcluded: prepared.emptyExcluded,
				available: prepared.available, shown: prepared.shown, truncated: prepared.truncated, maxCells: prepared.maxCells };
			state.notices = notices(prepared, entry.result, api);
			state.selected = null;
			state.drawing = { phase: 'drawing', created: 0, total: prepared.shown };
			render();
			return deps.renderer.render(prepared.cells, {
				onProgress: function (progress) {
					if (mySeq === drawSeq) {
						state.drawing.created = progress.created;
						render();
					}
				}
			}).then(function (result) {
				if (mySeq !== drawSeq) {
					return; // 더 새로 그리기 시작했거나 껐다.
				}
				state.drawing = { phase: result.status, created: result.created, total: result.total, errors: result.errors };
				render();
			});
		}

		function fetchGrid(size) {
			var key = state.targetKey + ':' + size;
			if (state.request.key === key && state.request.phase === 'loading') {
				return; // 같은 분석·셀 크기를 이미 요청 중
			}
			var url = api.gridDensityUrl(state.target, size, deps.base);
			abort();
			clearDrawing();
			if (!url) {
				state.request = { key: key, size: size, phase: 'error',
					error: api.describeError({ status: 400, body: { error: 'INVALID_TOKEN' } }) };
				turnOff(true);
				render();
				return;
			}
			var mySeq = seq;
			controller = typeof AbortController === 'function' ? new AbortController() : null;
			state.request = { key: key, size: size, phase: 'loading', error: null };
			state.requestCount++;
			render();
			deps.fetchJson(url, controller ? controller.signal : undefined).then(function (res) {
				if (mySeq !== seq || key !== state.request.key) {
					return; // 셀 크기·분석 변경, 끄기, 저장 전환으로 대체된 응답
				}
				controller = null;
				if (res && res.aborted) {
					return;
				}
				var checked = res && res.ok ? validateResponse(res.body, size) : null;
				if (checked && checked.ok) {
					remember(size, checked.result);
					state.request.phase = 'done';
					if (state.display && state.cellSize === size) {
						draw(cached(size));
					}
					render();
					return;
				}
				var error = checked
					? { code: 'GRID_INTEGRITY', message: INTEGRITY_MESSAGE, retryable: true, serviceDown: false }
					: api.describeError(res, deps.online ? deps.online() : true);
				state.request.phase = 'error';
				state.request.error = error;
				turnOff(true);
				if (error.serviceDown && deps.refreshStatus) {
					deps.refreshStatus();
				}
				render();
			});
		}

		function showSize(size) {
			var entry = cached(size);
			if (entry) {
				abort();
				state.request = { key: state.targetKey + ':' + size, size: size, phase: 'done', error: null };
				draw(entry);
			} else {
				fetchGrid(size);
			}
		}

		/* gis:analysisresult detail */
		function setAnalysis(detail) {
			var source = detail && detail.source;
			var target = null;
			if (source === 'saved' && detail.analysisId != null) {
				target = { generation: detail.generation, kind: 'saved', analysisId: detail.analysisId, token: null };
			} else if (source === 'live') {
				target = { generation: detail.generation, kind: 'snapshot', analysisId: null, token: detail.analysisToken || null };
			}
			var key = analysisKey(target);
			if (key === state.targetKey) {
				render();
				return;
			}
			// 분석이 바뀌었다(새 분석, 저장본 열기, 초기화): 요청·캐시·도형을 모두 정리하고 표시를 끈다.
			turnOff(false);
			state.target = target;
			state.targetKey = key;
			state.cache = [];
			render();
		}

		/* gis:analysissaved detail { generation, analysisId } */
		function analysisSaved(detail) {
			var target = state.target;
			if (!detail || !target || target.kind !== 'snapshot' || target.generation !== detail.generation
					|| detail.analysisId == null) {
				return;
			}
			state.target = { generation: target.generation, kind: 'saved', analysisId: detail.analysisId, token: null };
			state.targetKey = analysisKey(state.target);
			// 같은 분석이므로 그린 격자와 캐시는 그대로 둔다. 스냅샷 요청이 진행 중이었으면 ID로 다시 요청한다.
			if (state.request.phase === 'loading') {
				var size = state.request.size;
				abort();
				state.request = { key: null, size: null, phase: 'idle', error: null };
				fetchGrid(size);
				return;
			}
			if (state.request.key) {
				state.request.key = state.targetKey + ':' + state.request.size;
			}
			render();
		}

		function setService(serviceState) {
			state.service = serviceState;
			if (state.request.phase === 'blocked' && !serviceBlocked() && serviceState !== 'checking') {
				state.request = { key: null, size: null, phase: 'idle', error: null };
			}
			render();
		}

		/* 격자 표시 켜기·끄기. 켤 수 없으면 false. */
		function setDisplay(on) {
			if (!on) {
				turnOff(false);
				render();
				return true;
			}
			if (state.display) {
				return true;
			}
			if (!state.target) {
				render();
				return false;
			}
			if (serviceBlocked()) {
				state.request = { key: null, size: null, phase: 'blocked', error: null };
				render();
				return false;
			}
			// 다른 지도 레이어(핫스팟)를 먼저 끈다. 그쪽이 건물을 다시 보이게 한 뒤에 격자가 건물을 숨긴다.
			if (deps.dispatchLayer) {
				deps.dispatchLayer('grid');
			}
			state.display = true;
			buildings(false);
			showSize(state.cellSize);
			return true;
		}

		/* gis:spatiallayerchange: 핫스팟 레이어가 켜졌으면 격자를 끈다. 이벤트를 다시 보내지 않는다. */
		function layerChanged(layer) {
			if (layer !== 'hotspot' || !state.display) {
				return;
			}
			turnOff(false);
			render();
		}

		function setCellSize(size) {
			if (api.GRID_CELL_SIZES.indexOf(size) < 0 || size === state.cellSize) {
				return;
			}
			state.cellSize = size;
			if (state.display) {
				showSize(size);
			} else {
				render();
			}
		}

		function setExcludeEmpty(flag) {
			state.excludeEmpty = !!flag;
			var entry = cached(state.cellSize);
			if (state.display && entry && state.request.phase !== 'loading') {
				draw(entry);
			} else {
				render();
			}
		}

		/* 측정 초기화로 엔진 도형이 모두 지워진 뒤: 켜져 있으면 보관한 셀로 다시 그린다. */
		function measureReset() {
			if (!state.display || !deps.renderer.hasCells()) {
				return false;
			}
			var mySeq = ++drawSeq;
			state.drawing = { phase: 'drawing', created: 0, total: state.prepared ? state.prepared.shown : 0 };
			render();
			deps.renderer.restore({
				onProgress: function (progress) {
					if (mySeq === drawSeq) {
						state.drawing.created = progress.created;
						render();
					}
				}
			}).then(function (result) {
				if (mySeq === drawSeq) {
					state.drawing = { phase: result.status, created: result.created, total: result.total, errors: result.errors };
					render();
				}
			});
			return true;
		}

		/* 셀 클릭 (spatial-grid-renderer.js pick handler) */
		function pick(cellId) {
			var mode = deps.mode ? deps.mode() : null;
			if (MEASURE_MODES.indexOf(mode) >= 0 || !state.display) {
				return false; // 측정·좌표 조회 중에는 무시
			}
			var analysis = deps.analysis ? deps.analysis() : null;
			if (analysis && typeof analysis.suppressNextMapClick === 'function') {
				analysis.suppressNextMapClick(); // 이어지는 지도 클릭이 반경 중심점을 바꾸지 않게
			}
			var entry = cached(state.cellSize);
			var props = entry ? entry.index[String(cellId)] : null;
			state.selected = props ? cellDetail(cellId, props, state.cellSize, api) : null;
			render();
			if (state.selected && deps.openGridView) {
				deps.openGridView();
			}
			return !!state.selected;
		}

		function retry() {
			if (state.request.phase !== 'error') {
				return;
			}
			state.request = { key: null, size: null, phase: 'idle', error: null };
			setDisplay(true);
		}

		return {
			setAnalysis: setAnalysis,
			analysisSaved: analysisSaved,
			setService: setService,
			setDisplay: setDisplay,
			setCellSize: setCellSize,
			setExcludeEmpty: setExcludeEmpty,
			measureReset: measureReset,
			layerChanged: layerChanged,
			pick: pick,
			retry: retry,
			getState: function () {
				return state;
			}
		};
	}

	/* ---------- 화면 (브라우저) ---------- */

	function start(doc, win) {
		var api = win.gisSpatialApi;
		var model = win.gisGridModel;
		var renderer = win.gisGridRenderer;
		var script = doc.currentScript;
		var $ = function (id) {
			return doc.getElementById(id);
		};
		var el = {
			view: $('spatial-view-grid'),
			empty: $('grid-empty'),
			display: $('grid-display'),
			sizes: [$('grid-size-50'), $('grid-size-100'), $('grid-size-200')],
			excludeEmpty: $('grid-exclude-empty'),
			status: $('grid-status'),
			retry: $('grid-retry'),
			summary: $('grid-summary'),
			notices: $('grid-notices'),
			legend: $('grid-legend'),
			detail: $('grid-detail')
		};
		if (!api || !model || !renderer || !el.view || !el.display || !el.status) {
			return;
		}
		var base = (script && script.getAttribute('data-api-base')) || '/api';

		function show(node, visible) {
			if (node) {
				node.hidden = !visible;
			}
		}

		function make(tag, className, value) {
			var node = doc.createElement(tag);
			if (className) {
				node.className = className;
			}
			if (value != null) {
				node.textContent = value;
			}
			return node;
		}

		function renderLegend() {
			el.legend.textContent = '';
			model.legend().forEach(function (item) {
				var li = make('li', 'grid-legend__item');
				li.setAttribute('data-legend', item.key);
				var swatch = make('span', 'grid-legend__swatch' + (item.rgba ? '' : ' grid-legend__swatch--boundary'));
				if (item.rgba) {
					swatch.style.backgroundColor = 'rgba(' + item.rgba[0] + ', ' + item.rgba[1] + ', ' + item.rgba[2] + ', '
						+ (item.rgba[3] / 255).toFixed(2) + ')';
				}
				li.appendChild(swatch);
				li.appendChild(make('span', 'grid-legend__label', item.label));
				el.legend.appendChild(li);
			});
		}

		function statusText(state) {
			var request = state.request;
			if (request.phase === 'blocked') {
				return '공간 분석 서버를 사용할 수 없어 격자를 표시할 수 없습니다. 지도, 반경 분석과 분석 이력은 계속 사용할 수 있습니다.';
			}
			if (request.phase === 'error') {
				return request.error ? request.error.message : '';
			}
			if (request.phase === 'loading') {
				return '격자 밀집도를 계산하고 있습니다... (셀 ' + api.formatNumber(request.size, 0) + 'm)';
			}
			var drawing = state.drawing;
			if (drawing.phase === 'drawing') {
				return '지도에 격자를 그리고 있습니다... (' + api.formatNumber(drawing.created, 0) + ' / '
					+ api.formatNumber(drawing.total, 0) + ')';
			}
			if (drawing.phase === 'failed' || drawing.phase === 'unsupported') {
				return '지도에 격자를 그리지 못했습니다. 지도가 표시된 뒤 다시 켜 보세요.';
			}
			if (drawing.phase === 'done' && drawing.errors > 0) {
				return '셀 ' + api.formatNumber(drawing.errors, 0) + '개를 지도에 그리지 못했습니다.';
			}
			return '';
		}

		function render(state) {
			var hasTarget = !!state.target;
			var blocked = state.service === 'unavailable' || state.service === 'not-configured';
			el.view.setAttribute('data-state', state.display ? (state.request.phase === 'loading' ? 'loading' : state.drawing.phase)
				: (state.request.phase === 'error' ? 'error' : 'off'));
			el.view.setAttribute('aria-busy', String(state.request.phase === 'loading' || state.drawing.phase === 'drawing'));
			show(el.empty, !hasTarget);
			el.display.checked = state.display;
			el.display.disabled = !state.display && (!hasTarget || blocked);
			el.sizes.forEach(function (button) {
				if (button) {
					button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-cell-size')) === state.cellSize));
					button.disabled = !hasTarget;
				}
			});
			el.excludeEmpty.checked = state.excludeEmpty;
			el.excludeEmpty.disabled = !hasTarget;
			var message = statusText(state);
			el.status.textContent = message;
			el.status.className = 'spatial__status' + (state.request.phase === 'error' || state.request.phase === 'blocked'
				|| state.drawing.phase === 'failed' ? ' is-error' : '');
			show(el.status, !!message);
			show(el.retry, state.request.phase === 'error' && !!state.request.error && state.request.error.retryable);
			var drawn = state.display && !!state.prepared;
			el.summary.textContent = drawn ? summaryText(state.prepared, state.cellSize, api) : '';
			show(el.summary, drawn);
			el.notices.textContent = '';
			(drawn ? state.notices : []).forEach(function (text) {
				el.notices.appendChild(make('li', null, text));
			});
			show(el.notices, drawn && state.notices.length > 0);
			el.detail.textContent = '';
			if (state.selected) {
				el.detail.appendChild(make('h3', 'analysis__subtitle', state.selected.title));
				var list = make('dl', 'info-list grid-detail__list');
				state.selected.rows.forEach(function (row) {
					var item = make('div', 'info-list__row');
					item.appendChild(make('dt', null, row.label));
					item.appendChild(make('dd', null, row.value));
					list.appendChild(item);
				});
				el.detail.appendChild(list);
				state.selected.notes.forEach(function (note) {
					el.detail.appendChild(make('p', 'panel-hint', note));
				});
			}
			show(el.detail, !!state.selected);
		}

		var analysis = win.gisAnalysis;
		var controller = createController({
			api: api,
			model: model,
			renderer: renderer,
			analysisRenderer: function () {
				return win.gisAnalysisRenderer;
			},
			analysis: function () {
				return win.gisAnalysis;
			},
			mode: function () {
				return win.gisTools && typeof win.gisTools.getMode === 'function' ? win.gisTools.getMode() : null;
			},
			fetchJson: function (url, signal) {
				return api.getJson(url, signal);
			},
			base: base,
			online: function () {
				return win.navigator.onLine !== false;
			},
			render: render,
			dispatchLayer: function (layer) {
				doc.dispatchEvent(new win.CustomEvent('gis:spatiallayerchange', { detail: { layer: layer } }));
			},
			refreshStatus: function () {
				if (win.gisSpatialDashboard && win.gisSpatialDashboard.refreshStatus) {
					win.gisSpatialDashboard.refreshStatus();
				}
			},
			// 셀 정보를 보여 줄 격자 보기를 연다. 작은 화면에서는 지도를 가리지 않도록 패널을 열지 않는다.
			openGridView: function () {
				if (win.gisLayout && typeof win.gisLayout.isMobile === 'function' && win.gisLayout.isMobile()) {
					return;
				}
				if (win.gisSpatialViews && typeof win.gisSpatialViews.show === 'function') {
					win.gisSpatialViews.show('grid');
				}
				if (analysis && typeof analysis.openInfoPanel === 'function') {
					analysis.openInfoPanel('spatial');
				}
			}
		});

		renderer.setPickHandler(controller.pick);
		renderLegend();
		el.display.addEventListener('change', function () {
			controller.setDisplay(el.display.checked);
			render(controller.getState()); // 켤 수 없었으면 체크를 되돌린다.
		});
		el.sizes.forEach(function (button) {
			if (button) {
				button.addEventListener('click', function () {
					controller.setCellSize(Number(button.getAttribute('data-cell-size')));
				});
			}
		});
		el.excludeEmpty.addEventListener('change', function () {
			controller.setExcludeEmpty(el.excludeEmpty.checked);
		});
		if (el.retry) {
			el.retry.addEventListener('click', controller.retry);
		}
		doc.addEventListener('gis:analysisresult', function (event) {
			controller.setAnalysis(event.detail);
		});
		doc.addEventListener('gis:analysissaved', function (event) {
			controller.analysisSaved(event.detail);
		});
		doc.addEventListener('gis:spatialstatus', function (event) {
			controller.setService(event.detail && event.detail.state);
		});
		doc.addEventListener('gis:measurereset', function () {
			controller.measureReset();
		});
		doc.addEventListener('gis:spatiallayerchange', function (event) {
			controller.layerChanged(event.detail && event.detail.layer);
		});

		if (analysis && analysis.getCurrent) {
			controller.setAnalysis(analysis.getCurrent());
		}
		var dashboard = win.gisSpatialDashboard;
		controller.setService(dashboard && dashboard.getState ? dashboard.getState().service.state : 'checking');

		win.gisSpatialGrid = {
			getState: controller.getState,
			setDisplay: controller.setDisplay,
			setCellSize: controller.setCellSize
		};
	}

	return {
		DEFAULT_CELL_SIZE: DEFAULT_CELL_SIZE,
		MAX_CACHE: MAX_CACHE,
		validateResponse: validateResponse,
		indexCells: indexCells,
		cellDetail: cellDetail,
		notices: notices,
		summaryText: summaryText,
		createController: createController,
		start: start
	};
});
