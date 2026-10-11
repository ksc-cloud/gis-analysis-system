/*
 * GIS 3D 지도 - 반경 분석 (중심점 선택, 반경 설정, 분석 요청, 결과 패널)
 *
 * - map-tools.js의 'radius' 모드에서만 지도 클릭으로 중심점을 고른다. (건물 선택은 building-info.js가 자체 차단)
 * - 분석 전에는 원과 중심점만 미리보기로 표시하고 건물 수 등 결과로 오해할 수 있는 값은 표시하지 않는다.
 * - 분석은 서버(/api/buildings/nearby)가 VWorld LT_C_SPBD를 조회하고 다각형-원 교차를 판정한 결과다.
 * - 요청은 AbortController + 요청 번호로 관리해 늦게 도착한 이전 응답을 무시한다.
 * - 완료된 결과는 모드를 바꿔도 유지하고, 새 중심점/반경 변경/분석 초기화 때만 지운다.
 * - 오른쪽 패널에 "건물 정보 / 반경 분석" 탭을 두어 서로의 내용을 덮어쓰지 않는다.
 * - 3D 모델 ID(TD_ID)와 건물관리번호는 서로 다른 식별자이므로 연결하지 않는다.
 * - 같은 결과 화면으로 저장된 분석(GET /api/analyses/{id}의 result)도 보여 준다. (7단계, showSaved)
 *   저장본은 보라/분홍 도형, "저장된 분석" 문구와 안내 띠, 지도 위 표시 막대로 실시간 결과와 구분한다.
 * - 결과가 바뀔 때마다 'gis:analysisresult' 이벤트를 보낸다. (저장/이력 API 통신은 map-history.js 담당)
 * - 정보 패널의 "공간 분석" 탭 전환도 여기서 한다. 탭 내용(공간 통계)은 spatial-dashboard.js가 그린다.
 * - 지도 위 공통 패널(#tool-bar)의 접기/펼치기는 map-tools.js가 관리한다. 이 파일은 반경 분석 요약 문구를
 *   'gis:toolbarsummary' 이벤트로 보내고, 검색의 "이 위치로 반경 분석"과 저장본의 "같은 범위로 다시 분석"에서만
 *   window.gisTools.setCollapsed(false)로 패널을 펼친다.
 */
(function () {
	'use strict';

	var MIN_RADIUS = 50;
	var MAX_RADIUS = 1000;
	var MAP_LIMIT = 300;
	var PAGE_SIZE = 50;
	var NO_INFO = '정보 없음';
	var BOUNDS = { minLon: 124, maxLon: 132, minLat: 33, maxLat: 39 };

	var script = document.currentScript;
	var API_URL = (script && script.getAttribute('data-api-url')) || '/api/buildings/nearby';

	var el = {
		controls: document.getElementById('radius-controls'),
		center: document.getElementById('radius-center'),
		radiusButtons: document.querySelectorAll('#radius-controls [data-radius]'),
		custom: document.getElementById('radius-custom'),
		customApply: document.getElementById('radius-custom-apply'),
		summary: document.getElementById('radius-summary'),
		run: document.getElementById('radius-run'),
		reset: document.getElementById('radius-reset'),
		openResults: document.getElementById('radius-open-results'),
		message: document.getElementById('tool-bar-message'),
		tabBuilding: document.getElementById('tab-building'),
		tabAnalysis: document.getElementById('tab-analysis'),
		tabHistory: document.getElementById('tab-history'),
		tabSpatial: document.getElementById('tab-spatial'),
		buildingSection: document.getElementById('building-section'),
		historySection: document.getElementById('history-section'),
		spatialSection: document.getElementById('spatial-section'),
		kind: document.getElementById('analysis-kind'),
		savedBanner: document.getElementById('analysis-saved-banner'),
		savedTitle: document.getElementById('analysis-saved-title'),
		savedMeta: document.getElementById('analysis-saved-meta'),
		savedRerun: document.getElementById('analysis-saved-rerun'),
		savedClose: document.getElementById('analysis-saved-close'),
		savedBar: document.getElementById('saved-analysis-bar'),
		savedBarTitle: document.getElementById('saved-analysis-bar-title'),
		savedBarOpen: document.getElementById('saved-analysis-bar-open'),
		savedBarClose: document.getElementById('saved-analysis-bar-close'),
		section: document.getElementById('analysis-section'),
		empty: document.getElementById('analysis-empty'),
		status: document.getElementById('analysis-status'),
		result: document.getElementById('analysis-result'),
		resCenter: document.getElementById('analysis-center'),
		resRadius: document.getElementById('analysis-radius'),
		resCriterion: document.getElementById('analysis-criterion'),
		resCount: document.getElementById('analysis-count'),
		resInside: document.getElementById('analysis-inside'),
		resPartial: document.getElementById('analysis-partial'),
		resFetched: document.getElementById('analysis-fetched'),
		completeness: document.getElementById('analysis-completeness'),
		floors: document.getElementById('analysis-floors'),
		floorsNote: document.getElementById('analysis-floors-note'),
		mapNote: document.getElementById('analysis-map-note'),
		list: document.getElementById('analysis-list'),
		more: document.getElementById('analysis-more'),
		clear: document.getElementById('analysis-clear'),
		source: document.getElementById('analysis-source'),
		selectionBarOpen: document.getElementById('selection-bar-open')
	};

	if (!el.controls || !el.section || !el.run) {
		return;
	}

	var renderer = window.gisAnalysisRenderer;
	var map = null;
	var registered = false;
	var state = {
		center: null,
		radius: 500,
		status: 'idle', // idle | preview | loading | done | error
		result: null,
		drawnIds: {},
		shown: 0,
		selectedId: null,
		source: null, // null | 'live' | 'saved'
		saved: null, // 저장본일 때 { analysisId, title, analyzedAt, savedAt }
		generation: 0 // 결과가 바뀔 때마다 증가 (늦게 끝난 저장 요청이 새 결과 화면을 건드리지 않게 하는 기준)
	};
	var controller = null;
	var requestSeq = 0;
	var suppressClickUntil = 0;

	function mode() {
		return window.gisTools ? window.gisTools.getMode() : null;
	}

	function isMobile() {
		return !!(window.gisLayout && window.gisLayout.isMobile());
	}

	function setText(node, value) {
		if (node) {
			node.textContent = value == null || value === '' ? NO_INFO : String(value);
		}
	}

	function setMessage(text) {
		if (el.message && mode() === 'radius') {
			el.message.textContent = text || '';
		}
	}

	function formatCoord(c) {
		return c.lat.toFixed(6) + ', ' + c.lon.toFixed(6) + ' (위도, 경도)';
	}

	function formatRadius(r) {
		return r >= 1000 ? (r / 1000) + 'km (' + r + 'm)' : r + 'm';
	}

	function pad(n) {
		return n < 10 ? '0' + n : String(n);
	}

	// ISO-8601(UTC) 문자열을 브라우저 지역 시간 "YYYY-MM-DD HH:mm"으로 표시한다.
	function formatDateTime(iso) {
		var date = iso ? new Date(iso) : null;
		if (!date || isNaN(date.getTime())) {
			return NO_INFO;
		}
		return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' '
			+ pad(date.getHours()) + ':' + pad(date.getMinutes());
	}

	// 코드포인트(이모지 등 포함) 기준으로 자른다.
	function shorten(text, max) {
		var chars = Array.from(String(text));
		return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
	}

	/* ---------- 탭 ---------- */

	var TABS = ['building', 'analysis', 'history', 'spatial'];

	function tabParts(name) {
		if (name === 'building') {
			return [el.tabBuilding, el.buildingSection];
		}
		if (name === 'spatial') {
			return [el.tabSpatial, el.spatialSection];
		}
		return name === 'history' ? [el.tabHistory, el.historySection] : [el.tabAnalysis, el.section];
	}

	// 건물 정보 / 반경 분석 / 분석 이력 / 공간 분석 탭. 선택된 탭의 패널만 보이고, 'gis:tabchange'로 알린다.
	function showTab(name) {
		if (TABS.indexOf(name) < 0 || !tabParts(name)[1]) {
			name = 'analysis';
		}
		TABS.forEach(function (tabName) {
			var parts = tabParts(tabName);
			var active = tabName === name;
			if (parts[1]) {
				parts[1].hidden = !active;
			}
			if (parts[0]) {
				parts[0].setAttribute('aria-selected', String(active));
				parts[0].setAttribute('tabindex', active ? '0' : '-1');
				parts[0].classList.toggle('is-active', active);
			}
		});
		document.dispatchEvent(new CustomEvent('gis:tabchange', { detail: { tab: name } }));
	}

	function openInfoPanel(tab) {
		showTab(tab);
		if (window.gisLayout) {
			window.gisLayout.openPanel('info');
		}
	}

	/* ---------- 상태 표시 ---------- */

	function abortRequest() {
		requestSeq++;
		if (controller) {
			controller.abort();
			controller = null;
		}
	}

	function renderControls() {
		Array.prototype.forEach.call(el.radiusButtons, function (button) {
			button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-radius')) === state.radius));
		});
		el.center.textContent = state.center
			? '중심점: ' + formatCoord(state.center) + ' · 반경 ' + formatRadius(state.radius)
			: '중심점: 선택되지 않음 (지도를 클릭하세요)';
		el.run.disabled = !state.center || state.status === 'loading';
		el.run.textContent = state.status === 'loading' ? '분석 중...' : '분석 실행';
		el.reset.disabled = state.status === 'idle';

		var summary = '';
		if (state.status === 'preview') {
			// 미리보기 단계에서는 건물 수 등 결과 수치를 표시하지 않는다.
			summary = '분석 전 · 범위 미리보기입니다. "분석 실행"을 눌러야 건물을 조회합니다.';
		} else if (state.status === 'loading') {
			summary = '반경 안의 건물을 조회하고 있습니다...';
		} else if (state.status === 'done' && state.result) {
			summary = summaryText(state.result);
		} else if (state.status === 'error') {
			summary = '분석에 실패했습니다.';
		}
		el.summary.textContent = summary;
		if (el.openResults) {
			el.openResults.hidden = !(isMobile() && (state.status === 'done' || state.status === 'error'));
		}
		publishSummary();
	}

	/* ---------- 공통 패널 요약 / 자동 펼침 (상태는 map-tools.js) ---------- */

	// 접힌 패널의 한 줄 요약: 현재 반경과 분석 상태 (제목 "반경 분석"은 #tool-bar-title이 표시)
	function collapsedStatusText() {
		if (state.status === 'done' && state.result) {
			var count = '건물 ' + state.result.summary.intersecting + '개' + (state.result.complete ? '' : ' (부분 결과)');
			return state.source === 'saved' ? '저장된 분석 · ' + count : '분석 완료 · ' + count;
		}
		return { idle: '중심점 미선택', preview: '분석 전', loading: '분석 중...', error: '분석 실패' }[state.status] || '';
	}

	// 패널이 접혀 있을 때 map-tools.js가 반경 분석 모드의 요약으로 보여 줄 문구를 보낸다.
	function publishSummary() {
		document.dispatchEvent(new CustomEvent('gis:toolbarsummary', {
			detail: { mode: 'radius', text: '반경 ' + formatRadius(state.radius) + ' · ' + collapsedStatusText() }
		}));
	}

	function expandToolBar() {
		if (window.gisTools && typeof window.gisTools.setCollapsed === 'function') {
			window.gisTools.setCollapsed(false);
		}
	}

	function countText(result) {
		var n = result.summary.intersecting;
		return result.complete ? n + '개' : n + '개 (부분 결과 · 실제 건물 수는 더 많을 수 있음)';
	}

	function summaryText(result) {
		var text = (state.source === 'saved' ? '저장된 분석 표시 중 · 건물 ' : '분석 완료 · 건물 ') + countText(result);
		var drawn = Object.keys(state.drawnIds).length;
		if (result.summary.intersecting > drawn) {
			text += ' · 지도 표시 ' + drawn + '개';
		}
		return text;
	}

	function setSectionState(stateName, statusText) {
		el.section.setAttribute('data-state', stateName);
		el.empty.hidden = stateName !== 'empty';
		el.status.hidden = !statusText;
		el.status.textContent = statusText || '';
		el.result.hidden = stateName !== 'done';
		if (el.clear) {
			el.clear.hidden = stateName === 'empty';
		}
		if (el.tabAnalysis) {
			el.tabAnalysis.classList.toggle('has-result', stateName === 'done');
		}
		renderSource();
	}

	// 실시간/저장본 구분 표시: 결과 배지 문구, 저장본 안내 띠, 지도 위 저장본 표시 막대
	function renderSource() {
		var done = el.section.getAttribute('data-state') === 'done' && !!state.result;
		var saved = done && state.source === 'saved' && !!state.saved;
		el.section.setAttribute('data-source', saved ? 'saved' : (done ? 'live' : ''));
		if (el.kind) {
			el.kind.hidden = !done;
			el.kind.textContent = saved ? '저장된 분석 결과' : '실시간 분석 결과';
			el.kind.className = 'analysis__kind analysis__kind--' + (saved ? 'saved' : 'live');
		}
		if (el.savedBanner) {
			el.savedBanner.hidden = !saved;
			if (saved) {
				el.savedTitle.textContent = state.saved.title;
				el.savedMeta.textContent = '분석 ' + formatDateTime(state.saved.analyzedAt) + ' · 저장 '
					+ formatDateTime(state.saved.savedAt) + ' · 저장 시점의 데이터이며 현재 VWorld 데이터와 다를 수 있습니다.';
			}
		}
		if (el.savedBar) {
			el.savedBar.hidden = !saved;
			if (saved && el.savedBarTitle) {
				el.savedBarTitle.textContent = state.saved.title;
			}
		}
	}

	function current() {
		var result = state.status === 'done' ? state.result : null;
		var saved = result && state.source === 'saved';
		return {
			generation: state.generation,
			source: result ? state.source : null,
			analysisToken: result && !saved ? result.analysisToken || null : null,
			snapshotExpiresAt: result && !saved ? result.snapshotExpiresAt || null : null,
			analyzedAt: result ? (saved ? state.saved.analyzedAt : result.analyzedAt || null) : null,
			analysisId: saved ? state.saved.analysisId : null,
			title: saved ? state.saved.title : null,
			radius: result ? result.radiusMeters : null,
			center: result ? { lon: result.center.lon, lat: result.center.lat } : null,
			buildingCount: result ? result.summary.intersecting : null,
			complete: result ? !!result.complete : null
		};
	}

	function notifyResult() {
		document.dispatchEvent(new CustomEvent('gis:analysisresult', { detail: current() }));
	}

	function clearResultPanel() {
		var hadResult = !!state.result;
		state.generation++;
		state.source = null;
		state.saved = null;
		state.result = null;
		state.drawnIds = {};
		state.shown = 0;
		state.selectedId = null;
		el.list.textContent = '';
		el.floors.textContent = '';
		el.completeness.textContent = '';
		el.more.hidden = true;
		setSectionState('empty', null);
		if (hadResult) {
			notifyResult();
		}
	}

	/* ---------- 중심점 / 반경 ---------- */

	function toDegrees(cartographic) {
		if (!cartographic || !isFinite(cartographic.longitude) || !isFinite(cartographic.latitude)) {
			return null;
		}
		return {
			lon: Number((cartographic.longitude * 180 / Math.PI).toFixed(7)),
			lat: Number((cartographic.latitude * 180 / Math.PI).toFixed(7))
		};
	}

	function inKorea(c) {
		return c.lon >= BOUNDS.minLon && c.lon <= BOUNDS.maxLon && c.lat >= BOUNDS.minLat && c.lat <= BOUNDS.maxLat;
	}

	// 새 중심점이나 반경이 정해지면 이전 결과를 지우고 미리보기로 돌아간다.
	function showPreview(message) {
		abortRequest();
		clearResultPanel();
		state.status = state.center ? 'preview' : 'idle';
		if (renderer) {
			renderer.clear();
			if (state.center && !renderer.showPreview(state.center, state.radius)) {
				message = '지도에 미리보기 원을 그리지 못했습니다. 분석은 실행할 수 있습니다.';
			}
		}
		renderControls();
		setMessage(message || '');
	}

	function selectCenter(cartographic) {
		var center = toDegrees(cartographic);
		if (!center) {
			setMessage('좌표를 얻을 수 없는 위치입니다. 지표면이나 건물을 클릭하세요.');
			return;
		}
		if (!inKorea(center)) {
			setMessage('대한민국 범위 안에서 중심점을 선택하세요.');
			return;
		}
		state.center = center;
		showPreview('');
	}

	/*
	 * 지도 검색 등에서 고른 지점을 반경 분석 중심점으로 정한다. (map-search.js "이 위치로 반경 분석")
	 * 지도 클릭으로 중심점을 고른 것과 같은 흐름이다: 반경 분석 모드로 전환하고, 이전 결과를 지우고, 미리보기 원만 그린다.
	 * 현재 반경 설정은 유지하며, 분석 API는 사용자가 "분석 실행"을 눌러야 호출된다.
	 */
	function startAt(point) {
		if (!point || !isFinite(point.lon) || !isFinite(point.lat) || !renderer || !renderer.isSupported()) {
			return false;
		}
		var center = { lon: Number(Number(point.lon).toFixed(7)), lat: Number(Number(point.lat).toFixed(7)) };
		if (!inKorea(center) || !map) {
			return false;
		}
		if (window.gisTools && mode() !== 'radius') {
			window.gisTools.setMode('radius');
		}
		if (mode() !== 'radius') {
			return false;
		}
		// 안내대로 "분석 실행"을 누를 수 있게 접혀 있던 패널을 펼친다. (표시만 변경)
		expandToolBar();
		state.center = center;
		showPreview('검색 위치를 중심점으로 정했습니다. 반경을 확인하고 "분석 실행"을 누르세요.');
		return true;
	}

	function setRadius(value) {
		var radius = Number(value);
		if (!/^\d+$/.test(String(value).trim()) || radius < MIN_RADIUS || radius > MAX_RADIUS) {
			setMessage('반경은 ' + MIN_RADIUS + '~' + MAX_RADIUS + 'm 사이의 정수로 입력하세요.');
			return false;
		}
		if (radius === state.radius && state.status !== 'idle') {
			renderControls();
			return true;
		}
		state.radius = radius;
		if (state.center) {
			showPreview('반경을 ' + formatRadius(radius) + '로 바꿨습니다. 분석을 다시 실행하세요.');
		} else {
			renderControls();
		}
		return true;
	}

	/* ---------- 분석 요청 ---------- */

	function errorMessage(status, body) {
		var code = body && body.error;
		if (status === 400) {
			return code === 'INVALID_RADIUS'
				? '반경 값이 올바르지 않습니다. (' + MIN_RADIUS + '~' + MAX_RADIUS + 'm 정수)'
				: '대한민국 범위 밖이거나 올바르지 않은 좌표입니다.';
		}
		if (status === 503) {
			return '서버에 VWorld API 키가 설정되지 않아 분석할 수 없습니다.';
		}
		if (status === 504) {
			return 'VWorld 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.';
		}
		if (status === 502) {
			return 'VWorld 데이터 조회에 실패했습니다.' + (body && body.vworldErrorCode ? ' (' + body.vworldErrorCode + ')' : '');
		}
		return '분석 중 오류가 발생했습니다. (HTTP ' + status + ')';
	}

	function run() {
		if (!state.center || state.status === 'loading') {
			return;
		}
		abortRequest();
		var seq = requestSeq;
		var center = state.center;
		var radius = state.radius;
		controller = typeof AbortController === 'function' ? new AbortController() : null;
		state.status = 'loading';
		clearResultPanel();
		setSectionState('loading', '반경 ' + formatRadius(radius) + ' 안의 건물을 조회하고 있습니다...');
		renderControls();
		setMessage('');

		var url = API_URL + '?lon=' + encodeURIComponent(center.lon) + '&lat=' + encodeURIComponent(center.lat)
			+ '&radius=' + encodeURIComponent(radius);
		fetch(url, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
			.then(function (response) {
				return response.json().catch(function () { return null; }).then(function (body) {
					return { ok: response.ok, status: response.status, body: body };
				});
			})
			.then(function (res) {
				if (seq !== requestSeq) {
					return; // 이후 요청이나 초기화로 대체된 응답
				}
				controller = null;
				if (!res.ok || !res.body || !res.body.summary || !Array.isArray(res.body.buildings)) {
					fail(res.ok ? '분석 응답 형식을 확인할 수 없습니다.' : errorMessage(res.status, res.body));
					return;
				}
				showResult(res.body);
			})
			.catch(function (error) {
				if (seq !== requestSeq || (error && error.name === 'AbortError')) {
					return;
				}
				controller = null;
				fail(navigator.onLine === false
					? '인터넷 연결이 끊어져 분석할 수 없습니다.'
					: '서버에 연결할 수 없어 분석하지 못했습니다.');
			});
	}

	function fail(message) {
		state.status = 'error';
		// 미리보기 원은 그대로 두어 같은 범위로 다시 실행할 수 있게 한다.
		setSectionState('error', message);
		renderControls();
		setMessage(message + ' "분석 실행"으로 다시 시도할 수 있습니다.');
	}

	/* ---------- 결과 ---------- */

	// 실시간 결과와 저장본이 같은 화면을 쓴다. renderer.showResult가 이전 분석 도형을 모두 지운 뒤 그린다.
	function displayResult(result, source, saved) {
		state.generation++;
		state.status = 'done';
		state.result = result;
		state.source = source;
		state.saved = saved || null;
		state.drawnIds = {};
		var toDraw = result.buildings.slice(0, MAP_LIMIT);
		var drawn = 0;
		if (renderer) {
			drawn = renderer.showResult({ lon: result.center.lon, lat: result.center.lat }, result.radiusMeters,
				toDraw.map(function (b) {
					return { id: b.id, relation: b.relation, polygons: b.polygons };
				}),
				source === 'saved' ? { style: 'saved', label: '저장된 분석 · ' + shorten(saved.title, 30) } : undefined);
			toDraw.forEach(function (b) {
				if (renderer.isDrawn(b.id)) {
					state.drawnIds[b.id] = true;
				}
			});
		}
		renderPanel(result, drawn);
		renderControls();
	}

	function showResult(result) {
		displayResult(result, 'live', null);
		setMessage(result.complete ? '' : '일부 건물만 조회된 결과입니다. 결과 패널의 안내를 확인하세요.');
		if (!isMobile()) {
			openInfoPanel('analysis');
		}
		notifyResult();
	}

	function isValidResult(result) {
		return !!(result && result.center && isFinite(result.center.lon) && isFinite(result.center.lat)
			&& isFinite(result.radiusMeters) && result.summary && Array.isArray(result.buildings));
	}

	/*
	 * 저장된 분석을 지도와 결과 패널에 표시한다. detail: GET /api/analyses/{id} 응답
	 * 진행 중인 실시간 분석은 취소하고, 이전 결과(실시간이든 저장본이든)를 지운 뒤 그린다.
	 * 중심점과 반경도 저장값으로 맞춰 "같은 범위로 다시 분석"할 수 있게 한다.
	 */
	function showSaved(detail) {
		if (!detail || !isValidResult(detail.result) || detail.analysisId == null) {
			return false;
		}
		var result = detail.result;
		abortRequest();
		clearResultPanel();
		state.center = { lon: result.center.lon, lat: result.center.lat };
		state.radius = result.radiusMeters;
		displayResult(result, 'saved', {
			analysisId: detail.analysisId,
			title: detail.title == null ? '' : String(detail.title),
			analyzedAt: detail.analyzedAt,
			savedAt: detail.savedAt
		});
		var moved = moveTo(state.center, Math.max(700, Math.round(result.radiusMeters * 3.2)));
		setMessage('저장된 분석을 표시했습니다.' + (moved ? '' : ' (지도 이동 실패)'));
		if (isMobile()) {
			// 작은 화면에서는 지도를 보여 주고, 지도 위 막대의 "결과 보기"로 패널을 연다.
			if (window.gisLayout) {
				window.gisLayout.closePanels();
			}
		} else {
			openInfoPanel('analysis');
		}
		notifyResult();
		return true;
	}

	// 지금 표시 중인 저장본이 삭제되면 표시를 해제한다.
	function clearSaved(analysisId) {
		if (state.status !== 'done' || state.source !== 'saved' || !state.saved
				|| state.saved.analysisId !== analysisId) {
			return false;
		}
		resetAnalysis('삭제된 저장 분석의 표시를 해제했습니다.');
		return true;
	}

	function rerunSaved() {
		if (!state.center) {
			return;
		}
		if (window.gisTools && mode() !== 'radius') {
			window.gisTools.setMode('radius');
		}
		// 다시 분석하는 동안의 상태와 결과를 볼 수 있게 접혀 있던 패널을 펼친다. (표시만 변경)
		expandToolBar();
		run();
	}

	function renderPanel(result, drawn) {
		setSectionState('done', null);
		el.resCenter.textContent = formatCoord(result.center);
		el.resRadius.textContent = formatRadius(result.radiusMeters);
		el.resCriterion.textContent = '건물 다각형과 반경 원의 교차 (내부 구멍 반영)';
		el.resCount.textContent = countText(result);
		el.resInside.textContent = result.summary.inside + '개';
		el.resPartial.textContent = result.summary.partial + '개';
		var fetched = '수신 ' + result.fetchedFeatures + '건';
		fetched += result.reportedTotal != null ? ' / VWorld 보고 ' + result.reportedTotal + '건' : ' / VWorld 전체 건수 알 수 없음';
		if (result.summary.mergedDuplicateFeatures > 0) {
			fetched += ' · 중복 ' + result.summary.mergedDuplicateFeatures + '건 병합';
		}
		if (result.summary.outsideExcluded > 0) {
			fetched += ' · 반경 밖 ' + result.summary.outsideExcluded + '건 제외';
		}
		el.resFetched.textContent = fetched;

		renderCompleteness(result);
		renderFloors(result.floorStatistics);

		var total = result.buildings.length;
		el.mapNote.textContent = total > MAP_LIMIT || drawn < Math.min(total, MAP_LIMIT)
			? '분석 결과 ' + total + '개 중 지도에는 가까운 ' + drawn + '개만 표시했습니다.'
			: (total ? '목록의 건물을 누르면 해당 위치로 이동합니다.' : '반경 안에서 조회된 건물이 없습니다.');
		el.source.textContent = '데이터 출처: ' + result.source.provider + ' · ' + result.source.layer + ' · '
			+ result.source.coordinateSystem + '. ' + result.source.notice;

		el.list.textContent = '';
		state.shown = 0;
		showMore();
	}

	function renderCompleteness(result) {
		el.completeness.textContent = '';
		el.completeness.classList.toggle('is-incomplete', !result.complete);
		var title = document.createElement('p');
		title.className = 'analysis__completeness-title';
		title.textContent = result.complete
			? '완전한 결과: VWorld가 보고한 대상 건물을 모두 받아 판정했습니다.'
			: '부분 결과: 일부 건물이 누락되었을 수 있습니다. 표시된 건물 수는 이 지역의 전체 건물 수가 아닙니다.';
		el.completeness.appendChild(title);
		if (!result.complete && result.incompleteReasons && result.incompleteReasons.length) {
			var ul = document.createElement('ul');
			result.incompleteReasons.forEach(function (reason) {
				var li = document.createElement('li');
				li.textContent = reason.message;
				ul.appendChild(li);
			});
			el.completeness.appendChild(ul);
		}
	}

	function renderFloors(stats) {
		el.floors.textContent = '';
		if (!stats) {
			return;
		}
		var max = 0;
		(stats.distribution || []).forEach(function (bucket) {
			max = Math.max(max, bucket.count);
		});
		(stats.distribution || []).forEach(function (bucket) {
			var li = document.createElement('li');
			li.className = 'analysis__floor';
			var label = document.createElement('span');
			label.className = 'analysis__floor-label';
			label.textContent = bucket.label;
			var bar = document.createElement('span');
			bar.className = 'analysis__floor-bar';
			bar.setAttribute('style', 'width:' + (max ? Math.round(bucket.count / max * 100) : 0) + '%');
			var count = document.createElement('span');
			count.className = 'analysis__floor-count';
			count.textContent = bucket.count + '개';
			li.appendChild(label);
			li.appendChild(bar);
			li.appendChild(count);
			el.floors.appendChild(li);
		});
		var note = '층수 정보 있음 ' + stats.withData + '개 · 정보 없음 ' + stats.withoutData + '개 (0 또는 유효하지 않은 값 포함)';
		if (stats.withData) {
			note += ' · 최저 ' + stats.min + '층, 최고 ' + stats.max + '층, 평균 ' + stats.average + '층';
		}
		el.floorsNote.textContent = note;
	}

	function formatAddress(b) {
		if (!b.roadName) {
			return null;
		}
		// gu 필드에는 읍/면 외에 법정동명도 들어오므로 도로명주소 표기에는 읍/면만 포함한다.
		var eupmyeon = /[읍면]$/.test(b.eupmyeon || '') ? b.eupmyeon : null;
		return [b.sido, b.sigungu, eupmyeon, b.roadName, b.buildingNumber]
			.filter(function (part) { return part; })
			.join(' ');
	}

	function formatFloors(value) {
		var text = value == null ? '' : String(value);
		return /^\d+$/.test(text) && Number(text) > 0 ? '지상 ' + text + '층' : '층수 ' + NO_INFO;
	}

	function createItem(b, index) {
		var li = document.createElement('li');
		li.className = 'analysis__item';
		li.setAttribute('data-id', b.id);
		var button = document.createElement('button');
		button.type = 'button';
		button.className = 'analysis__item-button';

		var head = document.createElement('span');
		head.className = 'analysis__item-head';
		var badge = document.createElement('span');
		badge.className = 'analysis__badge analysis__badge--' + b.relation.toLowerCase();
		badge.textContent = b.relation === 'INSIDE' ? '완전 포함' : '경계 걸침';
		var name = document.createElement('strong');
		var info = b.building || {};
		name.textContent = info.buildingName
			? (info.buildingSubName ? info.buildingName + ' (' + info.buildingSubName + ')' : info.buildingName)
			: '건물명 ' + NO_INFO;
		head.appendChild(badge);
		head.appendChild(name);

		var meta = document.createElement('span');
		meta.className = 'analysis__item-meta';
		var parts = [
			(index + 1) + '. ' + (b.centerInside ? '중심점 포함 (0m)' : b.distanceMeters.toFixed(1) + 'm'),
			formatFloors(info.groundFloorCount),
			formatAddress(info) || '도로명주소 ' + NO_INFO
		];
		if (!state.drawnIds[b.id]) {
			parts.push('지도 미표시');
		}
		meta.textContent = parts.join(' · ');

		button.appendChild(head);
		button.appendChild(meta);
		button.addEventListener('click', function () {
			selectBuilding(b.id, true);
		});
		li.appendChild(button);
		return li;
	}

	function showMore() {
		var buildings = state.result ? state.result.buildings : [];
		var end = Math.min(buildings.length, state.shown + PAGE_SIZE);
		for (var i = state.shown; i < end; i++) {
			var item = createItem(buildings[i], i);
			if (buildings[i].id === state.selectedId) {
				item.classList.add('is-selected');
			}
			el.list.appendChild(item);
		}
		state.shown = end;
		el.more.hidden = state.shown >= buildings.length;
		el.more.textContent = '더 보기 (' + state.shown + ' / ' + buildings.length + ')';
	}

	function findIndex(id) {
		var buildings = state.result ? state.result.buildings : [];
		for (var i = 0; i < buildings.length; i++) {
			if (buildings[i].id === id) {
				return i;
			}
		}
		return -1;
	}

	function centroid(b) {
		var sumLon = 0;
		var sumLat = 0;
		var n = 0;
		(b.polygons || []).forEach(function (rings) {
			var outer = rings[0] || [];
			for (var i = 0; i < outer.length - 1; i++) {
				sumLon += outer[i][0];
				sumLat += outer[i][1];
				n++;
			}
		});
		return n ? { lon: sumLon / n, lat: sumLat / n } : null;
	}

	function moveTo(point, height) {
		if (!map || typeof map.moveTo !== 'function' || !window.vw || typeof vw.CameraPosition !== 'function') {
			return false;
		}
		try {
			map.moveTo(new vw.CameraPosition(new vw.CoordZ(point.lon, point.lat, height || 400),
				new vw.Direction(0, -90, 0)));
			return true;
		} catch (e) {
			console.warn('[GIS 3D 지도] 지도 이동 실패', e);
			return false;
		}
	}

	function markListItem(id) {
		Array.prototype.forEach.call(el.list.childNodes, function (node) {
			if (node.classList) {
				node.classList.toggle('is-selected', node.getAttribute && node.getAttribute('data-id') === id);
				if (node.getAttribute && node.getAttribute('data-id') === id && typeof node.scrollIntoView === 'function') {
					node.scrollIntoView({ block: 'nearest' });
				}
			}
		});
	}

	// fromList: 목록에서 선택(지도 이동) / false: 지도 도형 클릭(목록 강조)
	function selectBuilding(id, fromList) {
		var index = findIndex(id);
		if (index < 0) {
			return;
		}
		var b = state.result.buildings[index];
		state.selectedId = id;
		while (state.shown <= index) {
			showMore();
		}
		markListItem(id);
		var highlighted = renderer ? renderer.highlight(id) : false;
		var label = (index + 1) + '번 건물';
		if (fromList) {
			var point = centroid(b);
			var moved = point ? moveTo(point) : false;
			if (isMobile() && window.gisLayout) {
				window.gisLayout.closePanels();
			}
			setMessage(label + (moved ? '으로 이동했습니다.' : ' 위치로 이동하지 못했습니다.')
				+ (highlighted ? '' : ' (지도에 표시되지 않은 건물)'));
		} else {
			if (!isMobile()) {
				showTab('analysis');
			}
			setMessage(label + '을 선택했습니다.' + (isMobile() ? ' "결과 보기"에서 목록을 확인하세요.' : ''));
		}
	}

	// 도형 클릭 직후 이어지는 지도 클릭이 새 중심점으로 처리되지 않게 한다. (엔진은 도형 picking을 먼저 알린다)
	function suppressNextMapClick() {
		suppressClickUntil = Date.now() + 400;
	}

	function onPicked(id) {
		suppressNextMapClick();
		selectBuilding(id, false);
	}

	/* ---------- 초기화 / 모드 ---------- */

	function resetAnalysis(message) {
		var wasSaved = state.status === 'done' && state.source === 'saved';
		abortRequest();
		state.center = null;
		state.status = 'idle';
		clearResultPanel();
		if (renderer) {
			renderer.clear();
		}
		renderControls();
		setMessage(typeof message === 'string' ? message
			: (wasSaved ? '저장된 분석 표시를 해제했습니다.' : '분석 결과를 초기화했습니다.') + ' (측정 결과는 유지됩니다)');
	}

	function onMapClick(windowPosition, ecefPosition, cartographic) {
		if (mode() !== 'radius') {
			return;
		}
		if (Date.now() < suppressClickUntil) {
			suppressClickUntil = 0;
			return;
		}
		selectCenter(cartographic);
	}

	function onModeChange(event) {
		var detail = event.detail || {};
		var entering = detail.mode === 'radius';
		el.controls.hidden = !entering;
		if (entering) {
			if (state.status === 'preview' && renderer && renderer.count() === 0 && state.center) {
				renderer.showPreview(state.center, state.radius);
			}
			renderControls();
			return;
		}
		if (detail.previous === 'radius') {
			if (state.status === 'loading') {
				// 진행 중인 요청은 취소하고, 다시 돌아오면 같은 범위로 실행할 수 있게 미리보기로 남긴다.
				abortRequest();
				state.status = 'preview';
				setSectionState('empty', null);
			}
			if (state.status === 'preview' && renderer) {
				// 분석하지 않은 범위 원은 다른 모드에서 결과로 오해하지 않도록 숨긴다.
				renderer.clear();
			}
		}
	}

	function register(readyMap) {
		if (registered || !readyMap) {
			return;
		}
		registered = true;
		map = readyMap;
		if (renderer) {
			renderer.setMap(readyMap);
			renderer.setPickHandler(onPicked);
		}
		if (readyMap.onClick && typeof readyMap.onClick.addEventListener === 'function') {
			readyMap.onClick.addEventListener(onMapClick);
		}
		renderControls();
	}

	Array.prototype.forEach.call(el.radiusButtons, function (button) {
		button.addEventListener('click', function () {
			el.custom.value = '';
			setRadius(button.getAttribute('data-radius'));
		});
	});
	el.customApply.addEventListener('click', function () {
		setRadius(el.custom.value);
	});
	el.custom.addEventListener('keydown', function (event) {
		if (event.key === 'Enter') {
			event.preventDefault();
			setRadius(el.custom.value);
		}
	});
	el.run.addEventListener('click', run);
	el.reset.addEventListener('click', function () {
		resetAnalysis();
	});
	if (el.clear) {
		el.clear.addEventListener('click', function () {
			resetAnalysis();
		});
	}
	if (el.savedRerun) {
		el.savedRerun.addEventListener('click', rerunSaved);
	}
	[el.savedClose, el.savedBarClose].forEach(function (button) {
		if (button) {
			button.addEventListener('click', function () {
				resetAnalysis();
			});
		}
	});
	if (el.savedBarOpen) {
		el.savedBarOpen.addEventListener('click', function () {
			openInfoPanel('analysis');
		});
	}
	el.more.addEventListener('click', showMore);
	if (el.openResults) {
		el.openResults.addEventListener('click', function () {
			openInfoPanel('analysis');
		});
	}
	if (el.tabBuilding) {
		el.tabBuilding.addEventListener('click', function () {
			showTab('building');
		});
	}
	if (el.tabAnalysis) {
		el.tabAnalysis.addEventListener('click', function () {
			showTab('analysis');
		});
	}
	if (el.tabHistory) {
		el.tabHistory.addEventListener('click', function () {
			showTab('history');
		});
	}
	if (el.tabSpatial) {
		el.tabSpatial.addEventListener('click', function () {
			showTab('spatial');
		});
	}
	// 건물 정보 패널(building-info.js)을 수정하지 않고, 건물이 선택되면 건물 정보 탭으로 전환한다.
	if (el.buildingSection && typeof MutationObserver === 'function') {
		new MutationObserver(function () {
			if (el.buildingSection.getAttribute('data-state') !== 'empty') {
				showTab('building');
			}
		}).observe(el.buildingSection, { attributes: true, attributeFilter: ['data-state'] });
	}
	if (el.selectionBarOpen) {
		el.selectionBarOpen.addEventListener('click', function () {
			showTab('building');
		});
	}

	document.addEventListener('gis:modechange', onModeChange);
	// 측정 결과 초기화(vw.Map.clear)로 지워진 분석 도형을 다시 그린다.
	document.addEventListener('gis:measurereset', function () {
		if (renderer && renderer.count() > 0) {
			renderer.restore();
		}
	});
	document.addEventListener('gis:mapready', function (event) {
		register(event.detail && event.detail.map);
	});
	if (window.gisMap) {
		register(window.gisMap);
	}

	window.gisAnalysis = {
		getState: function () {
			return {
				center: state.center, radius: state.radius, status: state.status, selectedId: state.selectedId,
				source: state.status === 'done' ? state.source : null
			};
		},
		// 저장/이력 모듈(map-history.js)용
		getCurrent: current,
		showSaved: showSaved,
		clearSaved: clearSaved,
		// 지도 검색 모듈(map-search.js)용: 중심점만 정하고 분석은 실행하지 않는다.
		startAt: startAt,
		// 격자 셀(spatial-grid.js) 등 다른 도형을 클릭한 직후의 지도 클릭이 반경 중심점을 바꾸지 않게 한다.
		suppressNextMapClick: suppressNextMapClick,
		showTab: showTab,
		openInfoPanel: openInfoPanel,
		formatDateTime: formatDateTime,
		formatRadius: formatRadius
	};
})();
