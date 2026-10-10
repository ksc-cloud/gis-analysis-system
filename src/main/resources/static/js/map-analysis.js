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
		buildingSection: document.getElementById('building-section'),
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
		selectedId: null
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

	/* ---------- 탭 ---------- */

	function showTab(name) {
		var analysis = name === 'analysis';
		el.section.hidden = !analysis;
		if (el.buildingSection) {
			el.buildingSection.hidden = analysis;
		}
		[[el.tabBuilding, !analysis], [el.tabAnalysis, analysis]].forEach(function (pair) {
			if (pair[0]) {
				pair[0].setAttribute('aria-selected', String(pair[1]));
				pair[0].setAttribute('tabindex', pair[1] ? '0' : '-1');
				pair[0].classList.toggle('is-active', pair[1]);
			}
		});
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
	}

	function countText(result) {
		var n = result.summary.intersecting;
		return result.complete ? n + '개' : n + '개 (부분 결과 · 실제 건물 수는 더 많을 수 있음)';
	}

	function summaryText(result) {
		var text = '분석 완료 · 건물 ' + countText(result);
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
	}

	function clearResultPanel() {
		state.result = null;
		state.drawnIds = {};
		state.shown = 0;
		state.selectedId = null;
		el.list.textContent = '';
		el.floors.textContent = '';
		el.completeness.textContent = '';
		el.more.hidden = true;
		setSectionState('empty', null);
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

	function showResult(result) {
		state.status = 'done';
		state.result = result;
		state.drawnIds = {};
		var toDraw = result.buildings.slice(0, MAP_LIMIT);
		var drawn = 0;
		if (renderer) {
			drawn = renderer.showResult({ lon: result.center.lon, lat: result.center.lat }, result.radiusMeters,
				toDraw.map(function (b) {
					return { id: b.id, relation: b.relation, polygons: b.polygons };
				}));
			toDraw.forEach(function (b) {
				if (renderer.isDrawn(b.id)) {
					state.drawnIds[b.id] = true;
				}
			});
		}
		renderPanel(result, drawn);
		renderControls();
		setMessage(result.complete ? '' : '일부 건물만 조회된 결과입니다. 결과 패널의 안내를 확인하세요.');
		if (!isMobile()) {
			showTab('analysis');
			if (window.gisLayout) {
				window.gisLayout.openPanel('info');
			}
		}
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

	function moveTo(point) {
		if (!map || typeof map.moveTo !== 'function' || !window.vw || typeof vw.CameraPosition !== 'function') {
			return false;
		}
		try {
			map.moveTo(new vw.CameraPosition(new vw.CoordZ(point.lon, point.lat, 400), new vw.Direction(0, -90, 0)));
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

	function onPicked(id) {
		// 도형 클릭 직후 이어지는 지도 클릭이 새 중심점으로 처리되지 않게 한다. (엔진은 도형 picking을 먼저 알린다)
		suppressClickUntil = Date.now() + 400;
		selectBuilding(id, false);
	}

	/* ---------- 초기화 / 모드 ---------- */

	function resetAnalysis() {
		abortRequest();
		state.center = null;
		state.status = 'idle';
		clearResultPanel();
		if (renderer) {
			renderer.clear();
		}
		renderControls();
		setMessage('분석 결과를 초기화했습니다. (측정 결과는 유지됩니다)');
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
	el.reset.addEventListener('click', resetAnalysis);
	if (el.clear) {
		el.clear.addEventListener('click', resetAnalysis);
	}
	el.more.addEventListener('click', showMore);
	if (el.openResults) {
		el.openResults.addEventListener('click', function () {
			showTab('analysis');
			if (window.gisLayout) {
				window.gisLayout.openPanel('info');
			}
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
			return { center: state.center, radius: state.radius, status: state.status, selectedId: state.selectedId };
		}
	};
})();
