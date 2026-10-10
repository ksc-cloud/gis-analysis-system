/*
 * GIS 3D 지도 - 3D 건물 선택 및 건물 정보 조회
 *
 * - 지도 준비(gis:mapready) 후 vw.Map.onClick 에 클릭 리스너를 한 번만 등록한다.
 *   콜백 인자: (windowPosition, ecefPosition, cartographic[라디안], pickedElement)
 *   3D 타일 객체를 클릭하면 pickedElement = { element, attributes } 이다.
 * - 건물 판별: VWorld 기본 건물 레이어(facility_build, 타일셋 TG9ENA)의 속성 TD_ID/MODEL_NAME 과
 *   타일 경로(__BASE_PATH__)로 판단한다. 지명 라벨(poi_*) 등 다른 3D 타일은 건물로 보지 않는다.
 * - 건물 정보: 클릭 좌표로 서버(/api/buildings/at)를 통해 VWorld LT_C_SPBD 를 조회한다.
 *   3D 모델 ID(TD_ID)와 건물관리번호(bd_mgt_sn)는 서로 다른 식별자로 취급한다.
 */
(function () {
	'use strict';

	var BUILDING_TILESET_PATH = '/TG9ENA/';
	var NO_INFO = '정보 없음';

	var script = document.currentScript;
	var apiUrl = (script && script.getAttribute('data-api-url')) || '/api/buildings/at';

	var el = {
		section: document.getElementById('building-section'),
		empty: document.getElementById('building-empty'),
		status: document.getElementById('building-status'),
		statusText: document.getElementById('building-status-text'),
		candidates: document.getElementById('building-candidates'),
		retry: document.getElementById('building-retry'),
		clear: document.getElementById('building-clear'),
		notice: document.getElementById('building-notice'),
		name: document.getElementById('info-name'),
		address: document.getElementById('info-address'),
		usage: document.getElementById('info-usage'),
		floors: document.getElementById('info-floors'),
		year: document.getElementById('info-year'),
		bdMgtSn: document.getElementById('info-bd-mgt-sn'),
		modelId: document.getElementById('info-model-id'),
		coord: document.getElementById('info-coord'),
		bar: document.getElementById('selection-bar'),
		barText: document.getElementById('selection-bar-text'),
		barOpen: document.getElementById('selection-bar-open'),
		barClear: document.getElementById('selection-bar-clear'),
		infoToggle: document.getElementById('info-panel-toggle')
	};

	if (!el.section) {
		return;
	}

	var registered = false;
	var selected = null;          // { modelId, lon, lat }
	var requestSeq = 0;
	var controller = null;
	var foundCache = {};          // TD_ID -> 조회 결과(FOUND 인 경우만)

	/* ---------- 건물 판별 ---------- */

	function isBuilding(picked) {
		var attrs = picked && picked.attributes;
		if (!attrs || attrs.TD_ID == null || attrs.MODEL_NAME == null) {
			return false;
		}
		return String(attrs.__BASE_PATH__ || '').indexOf(BUILDING_TILESET_PATH) !== -1;
	}

	function toDegrees(cartographic) {
		if (!cartographic || !isFinite(cartographic.longitude) || !isFinite(cartographic.latitude)) {
			return null;
		}
		return {
			lon: cartographic.longitude * 180 / Math.PI,
			lat: cartographic.latitude * 180 / Math.PI
		};
	}

	/* ---------- 강조 표시(선택 사항: VWorld 엔진 내부 속성, 지원될 때만) ---------- */

	function engineMap() {
		try {
			return (window.ws3d && ws3d.viewer && ws3d.viewer.map) || null;
		} catch (e) {
			return null;
		}
	}

	// 건물 선택 모드가 아닐 때는 끈다. 끄면 엔진이 클릭 때 강조를 바꾸지 않으므로 기존 선택 강조는 유지된다.
	function enableHighlight(enabled) {
		var wsMap = engineMap();
		try {
			if (wsMap && wsMap.isFeatureSilhouetteSupported === true && 'featureSilhouetteEnabled' in wsMap) {
				wsMap.featureSilhouetteEnabled = enabled !== false;
			}
		} catch (e) {
			console.warn('[GIS 3D 지도] 건물 강조 표시를 사용할 수 없습니다.', e);
		}
	}

	function clearHighlight() {
		var wsMap = engineMap();
		try {
			if (wsMap && wsMap.silhouetteFeatureController && Array.isArray(wsMap.silhouetteFeatureController.selected)) {
				wsMap.silhouetteFeatureController.selected = [];
				if (typeof wsMap.wakeupRenderer === 'function') {
					wsMap.wakeupRenderer();
				}
			}
		} catch (e) {
			// 강조 해제 실패는 선택 해제 동작에 영향을 주지 않는다.
		}
	}

	/* ---------- 화면 갱신 ---------- */

	function setText(node, value) {
		if (node) {
			node.textContent = (value == null || value === '') ? NO_INFO : String(value);
		}
	}

	function resetFields() {
		[el.name, el.address, el.usage, el.floors, el.year, el.bdMgtSn, el.modelId, el.coord].forEach(function (node) {
			if (node) {
				node.textContent = '-';
			}
		});
	}

	function setState(state, message) {
		el.section.setAttribute('data-state', state);
		var hasSelection = state !== 'empty';
		el.empty.hidden = hasSelection;
		el.clear.hidden = !hasSelection;
		el.notice.hidden = !hasSelection;
		el.status.hidden = !message;
		el.statusText.textContent = message || '';
		el.retry.hidden = state !== 'error';
		if (state !== 'ambiguous') {
			el.candidates.hidden = true;
			el.candidates.textContent = '';
		}
		if (el.infoToggle) {
			el.infoToggle.classList.toggle('has-selection', hasSelection);
		}
		if (el.bar) {
			el.bar.hidden = !hasSelection;
		}
	}

	function setBarText(text) {
		if (el.barText) {
			el.barText.textContent = text;
		}
	}

	function formatAddress(b) {
		if (!b.roadName) {
			return null;
		}
		// gu 필드에는 읍/면 외에 법정동명(예: 한강로3가)도 들어오므로, 도로명주소 표기에는 읍/면만 포함한다.
		var eupmyeon = /[읍면]$/.test(b.eupmyeon || '') ? b.eupmyeon : null;
		return [b.sido, b.sigungu, eupmyeon, b.roadName, b.buildingNumber]
			.filter(function (part) { return part; })
			.join(' ');
	}

	function formatName(b) {
		if (!b.buildingName) {
			return null;
		}
		return b.buildingSubName ? b.buildingName + ' (' + b.buildingSubName + ')' : b.buildingName;
	}

	function formatFloors(value) {
		if (value == null) {
			return null;
		}
		var text = String(value);
		if (/^\d+$/.test(text)) {
			// 실제 응답에서 0이 확인되었다. 0층으로 단정하지 않고 제공 값을 그대로 알린다.
			return Number(text) > 0 ? text + '층' : NO_INFO + ' (제공 값: ' + text + ')';
		}
		return text;
	}

	function showSelectionBase() {
		setText(el.modelId, selected.modelId);
		setText(el.coord, selected.lon == null
			? null
			: selected.lat.toFixed(6) + ', ' + selected.lon.toFixed(6) + ' (위도, 경도)');
		// 현재 연동한 API에서 제공하지 않는 항목
		setText(el.usage, null);
		setText(el.year, null);
	}

	function clearLookupFields() {
		[el.name, el.address, el.floors, el.bdMgtSn].forEach(function (node) {
			setText(node, null);
		});
	}

	function showFound(building) {
		setText(el.name, formatName(building));
		setText(el.address, formatAddress(building));
		setText(el.floors, formatFloors(building.groundFloorCount));
		setText(el.bdMgtSn, building.buildingManagementNumber);
		setState('found', null);
		setBarText((formatName(building) || '건물') + ' 선택됨');
	}

	function showAmbiguous(data) {
		clearLookupFields();
		setState('ambiguous', '클릭 위치에서 건물 ' + data.totalCount
			+ '개가 조회되어 하나로 확정하지 않았습니다. 건물 가운데를 다시 클릭해 보세요.');
		el.candidates.textContent = '';
		(data.buildings || []).forEach(function (b) {
			var item = document.createElement('li');
			item.textContent = (formatName(b) || '이름 없음') + ' · ' + (formatAddress(b) || '주소 정보 없음');
			el.candidates.appendChild(item);
		});
		el.candidates.hidden = !el.candidates.childNodes.length;
		setBarText('건물 선택됨 (정보 확인 필요)');
	}

	/* ---------- 조회 ---------- */

	function errorMessage(status, body) {
		if (body && body.error === 'API_KEY_MISSING') {
			return 'VWorld API 키가 설정되지 않아 건물 정보를 조회할 수 없습니다.';
		}
		if (body && body.vworldErrorCode) {
			return '건물 정보 조회에 실패했습니다. (' + body.vworldErrorCode + ') '
				+ (body.message || '') + ' API 키의 데이터 API 사용 여부와 서비스 URL 설정을 확인하세요.';
		}
		if (status === 504) {
			return '건물 정보 조회 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.';
		}
		return '건물 정보 조회에 실패했습니다. ' + ((body && body.message) || '');
	}

	function lookup() {
		if (controller) {
			controller.abort();
			controller = null;
		}
		var current = selected;
		if (!current) {
			return;
		}
		if (current.lon == null) {
			clearLookupFields();
			setState('no-info', '클릭 위치의 좌표를 확인할 수 없어 건물 정보를 조회하지 못했습니다.');
			setBarText('건물 선택됨');
			return;
		}
		if (foundCache[current.modelId]) {
			showFound(foundCache[current.modelId]);
			return;
		}

		var seq = ++requestSeq;
		controller = (typeof AbortController === 'function') ? new AbortController() : null;
		clearLookupFields();
		setState('loading', '건물 정보를 조회하는 중입니다.');
		setBarText('건물 정보 조회 중...');

		var url = apiUrl + '?lon=' + encodeURIComponent(current.lon) + '&lat=' + encodeURIComponent(current.lat);
		fetch(url, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
			.then(function (response) {
				return response.json().catch(function () { return null; }).then(function (body) {
					return { ok: response.ok, status: response.status, body: body };
				});
			})
			.then(function (result) {
				// 그 사이에 다른 건물을 선택했거나 선택을 해제했다면 늦게 도착한 응답은 버린다.
				if (seq !== requestSeq || selected !== current) {
					return;
				}
				controller = null;
				if (!result.ok || !result.body) {
					clearLookupFields();
					setState('error', errorMessage(result.status, result.body));
					setBarText('건물 정보 조회 실패');
					return;
				}
				var data = result.body;
				if (data.status === 'FOUND' && data.buildings && data.buildings.length === 1) {
					foundCache[current.modelId] = data.buildings[0];
					showFound(data.buildings[0]);
				} else if (data.status === 'AMBIGUOUS') {
					showAmbiguous(data);
				} else {
					clearLookupFields();
					setState('no-info', '클릭 위치에서 조회되는 도로명주소 건물 정보가 없습니다.');
					setBarText('건물 선택됨 (정보 없음)');
				}
			})
			.catch(function (error) {
				if (error && error.name === 'AbortError') {
					return;
				}
				if (seq !== requestSeq || selected !== current) {
					return;
				}
				controller = null;
				clearLookupFields();
				setState('error', navigator.onLine === false
					? '인터넷 연결이 끊어져 건물 정보를 조회할 수 없습니다.'
					: '서버에 연결할 수 없어 건물 정보를 조회하지 못했습니다.');
				setBarText('건물 정보 조회 실패');
			});
	}

	/* ---------- 선택 / 해제 ---------- */

	function select(modelId, coords) {
		selected = { modelId: String(modelId), lon: coords ? coords.lon : null, lat: coords ? coords.lat : null };
		showSelectionBase();
		lookup();
	}

	function clearSelection() {
		requestSeq++;
		if (controller) {
			controller.abort();
			controller = null;
		}
		selected = null;
		resetFields();
		setState('empty', null);
		clearHighlight();
	}

	// map-tools.js 가 없으면 항상 건물 선택 모드로 동작한다.
	function isSelectMode() {
		return !window.gisTools || window.gisTools.getMode() === 'select';
	}

	function onMapClick(windowPosition, ecefPosition, cartographic, picked) {
		// 거리/면적 측정, 좌표 조회 중에는 건물 선택과 정보 패널을 변경하지 않는다.
		if (!isSelectMode()) {
			return;
		}
		if (!isBuilding(picked)) {
			// 지형, 지명 라벨 등 건물이 아닌 곳을 클릭하면 선택을 해제한다.
			if (picked) {
				clearHighlight();
			}
			if (selected) {
				clearSelection();
			}
			return;
		}
		select(picked.attributes.TD_ID, toDegrees(cartographic));
	}

	function register(map) {
		if (registered || !map) {
			return;
		}
		if (!map.onClick || typeof map.onClick.addEventListener !== 'function') {
			el.empty.textContent = '이 지도 버전에서는 건물 선택 기능을 지원하지 않습니다.';
			console.warn('[GIS 3D 지도] vw.Map.onClick 을 사용할 수 없습니다.');
			return;
		}
		map.onClick.addEventListener(onMapClick);
		registered = true;
		enableHighlight(isSelectMode());
	}

	document.addEventListener('gis:modechange', function (event) {
		if (registered) {
			enableHighlight(event.detail && event.detail.mode === 'select');
		}
	});

	// 3D 건물 레이어를 숨기면 보이지 않는 건물이 선택된 상태로 남지 않도록 선택을 해제한다.
	document.addEventListener('gis:layerchange', function (event) {
		var detail = event.detail || {};
		if (detail.id === 'facility_build' && detail.visible === false && selected) {
			clearSelection();
		}
	});

	el.clear.addEventListener('click', clearSelection);
	el.retry.addEventListener('click', function () {
		if (selected) {
			lookup();
		}
	});
	if (el.barClear) {
		el.barClear.addEventListener('click', clearSelection);
	}
	if (el.barOpen) {
		el.barOpen.addEventListener('click', function () {
			if (window.gisLayout) {
				window.gisLayout.openPanel('info');
			}
		});
	}

	document.addEventListener('gis:mapready', function (event) {
		register(event.detail && event.detail.map);
	});
	if (window.gisMap) {
		register(window.gisMap);
	}
})();
