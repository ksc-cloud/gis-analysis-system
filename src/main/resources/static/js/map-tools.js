/*
 * GIS 3D 지도 - 지도 도구 모드 관리, 거리/면적 측정, 좌표 조회
 *
 * 모드: select(건물 선택, 기본) / distance(거리 측정) / area(면적 측정) / coord(좌표 조회) / radius(반경 분석)
 * - 반경 분석 동작과 화면은 map-analysis.js가 담당하고, 이 파일은 모드 전환만 관리한다.
 * - 한 번에 하나의 모드만 활성화하고, 변경 시 'gis:modechange' 이벤트를 발생시킨다.
 * - 측정은 VWorld 기본 기능(vw.MeasureLine / vw.MeasureArea)을 사용하고 결과는 VWorld 라벨로 표시한다.
 *   start(): 그리기 시작, clear(): 진행 중인 그리기 취소(+stop), 완료: 마우스 오른쪽 버튼.
 * - 결과 초기화는 vw.Map.clear()를 사용한다. (측정 결과만 지우는 공개 API가 없어 지도에 그린 객체 전체를 지운다)
 *   반경 분석 도형(저장본 포함)과 검색 마커도 함께 지워지므로 초기화 후 gis:measurereset 이벤트를 보내
 *   각 모듈(map-analysis.js, map-search.js)이 즉시 다시 그리게 한다. 사용자 입장에서는 측정 결과만 지워진다.
 * - 측정의 진입점은 이 메뉴뿐이다. (vworld-map.js: VWorld 오른쪽 막대의 측정·초기화 묶음은 isZoomControl로 만들지 않음)
 * - 좌표 조회는 vw.Map.onClick 콜백의 cartographic(라디안)을 WGS84 경위도로 변환한다.
 * - 지도 위 공통 패널(#tool-bar)의 접기/펼치기 상태는 이 파일 한 곳에서 관리한다. (거리·면적·좌표·반경 모드 공통,
 *   건물 선택 모드에서는 패널을 표시하지 않음) 접힌 상태는 모드를 바꿔도 유지하고, 새로 고치면 펼침으로 시작한다.
 *   접으면 현재 모드의 요약을 보여 준다. 반경 분석 요약은 map-analysis.js가 'gis:toolbarsummary' 이벤트로 보낸다.
 *   터치 기기에서 거리·면적 측정으로 들어가면 "완료" 버튼을 쓸 수 있게 자동으로 펼친다.
 */
(function () {
	'use strict';

	var MEASURE_MODES = { distance: true, area: true };

	var MODE_INFO = {
		distance: {
			title: '거리 측정',
			guide: '클릭: 지점 추가 · 마우스 오른쪽 버튼: 완료',
			touchGuide: '탭: 지점 추가 · "완료 (실험적)" 버튼: 완료',
			notice: '지형 미반영 수평 거리입니다. VWorld가 함께 표시하는 도보·자전거 시간은 추정값입니다.'
		},
		area: {
			title: '면적 측정',
			guide: '클릭: 지점 추가(3개 이상) · 마우스 오른쪽 버튼: 완료',
			touchGuide: '탭: 지점 추가(3개 이상) · "완료 (실험적)" 버튼: 완료',
			notice: 'WGS84 타원체 기준 면적이며 실제 지표면적과 다를 수 있습니다. 지점 라벨의 둘레는 높이 차를 포함한 직선거리입니다.'
		},
		coord: {
			title: '좌표 조회',
			guide: '지도를 클릭하면 해당 지점의 좌표를 표시합니다.',
			touchGuide: '지도를 탭하면 해당 지점의 좌표를 표시합니다.',
			notice: 'WGS84 경위도(EPSG:4326) 기준입니다.'
		},
		radius: {
			title: '반경 분석',
			guide: '지도를 클릭해 중심점을 고르고 반경을 정한 뒤 "분석 실행"을 누르세요.',
			touchGuide: '지도를 탭해 중심점을 고르고 반경을 정한 뒤 "분석 실행"을 누르세요.',
			notice: '지형을 반영하지 않은 수평 거리 기준입니다. 결과는 VWorld 도로명주소 건물(LT_C_SPBD) 데이터 기준입니다.'
		}
	};

	var el = {
		buttons: document.querySelectorAll('#map-tools [data-mode], #analysis-menu [data-mode]'),
		reset: document.getElementById('measure-reset'),
		hint: document.getElementById('map-tools-hint'),
		mapEl: document.getElementById('map'),
		bar: document.getElementById('tool-bar'),
		title: document.getElementById('tool-bar-title'),
		guide: document.getElementById('tool-bar-guide'),
		notice: document.getElementById('tool-bar-notice'),
		message: document.getElementById('tool-bar-message'),
		coordResult: document.getElementById('coord-result'),
		coordText: document.getElementById('coord-text'),
		coordCopy: document.getElementById('coord-copy'),
		complete: document.getElementById('tool-complete'),
		restart: document.getElementById('tool-restart'),
		cancel: document.getElementById('tool-cancel'),
		barReset: document.getElementById('tool-reset'),
		exit: document.getElementById('tool-exit'),
		toggle: document.getElementById('tool-bar-toggle'),
		summary: document.getElementById('tool-bar-summary')
	};

	if (!el.bar || !el.buttons.length) {
		return;
	}

	var map = null;
	var mode = 'select';
	var registered = false;
	var lastCoordText = '';
	var collapsed = false;
	// 거리·면적 측정 진행 상태(요약용): '' | 'drawing' | 'cancelled' | 'completed' | 'failed'
	var measureState = '';
	// 다른 모듈이 보내 준 모드별 요약 문구 (현재는 반경 분석)
	var externalSummaries = {};

	function isTouchDevice() {
		var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
		return coarse || !!(window.vw && vw.isMobile);
	}

	function setMessage(text) {
		el.message.textContent = text || '';
	}

	/* ---------- VWorld 측정 ---------- */

	function measureApi(measureMode) {
		if (!window.vw) {
			return null;
		}
		return measureMode === 'distance' ? vw.MeasureLine : (measureMode === 'area' ? vw.MeasureArea : null);
	}

	function startMeasure() {
		var api = measureApi(mode);
		if (!api || typeof api.start !== 'function') {
			setMessage('이 지도 버전에서는 ' + MODE_INFO[mode].title + ' 기능을 사용할 수 없습니다.');
			return;
		}
		try {
			api.start();
			measureState = 'drawing';
			setMessage('');
		} catch (e) {
			console.error('[GIS 3D 지도] 측정 시작 실패', e);
			cancelDrawing();
			measureState = 'failed';
			setMessage('측정을 시작하지 못했습니다. 다시 시도하세요.');
		}
		renderSummary();
	}

	// 진행 중인 그리기만 취소한다. 완료된 측정 결과(라벨/도형)는 남는다.
	function cancelDrawing() {
		['distance', 'area'].forEach(function (measureMode) {
			var api = measureApi(measureMode);
			if (api && typeof api.clear === 'function') {
				try {
					api.clear();
				} catch (e) {
					console.warn('[GIS 3D 지도] 측정 취소 중 오류', e);
				}
			}
		});
	}

	// 실험적: 터치 기기용 완료. VWorld 엔진 내부 메서드(objectManager.completeDrawing)로
	// 마우스 오른쪽 버튼과 같은 완료 처리를 호출한다. 실패하면 그리기만 취소하고 지도 기능은 유지한다.
	function completeDrawingExperimental() {
		var objectManager = null;
		try {
			objectManager = window.ws3d && ws3d.viewer && ws3d.viewer.objectManager;
		} catch (e) {
			objectManager = null;
		}
		if (!objectManager || typeof objectManager.completeDrawing !== 'function') {
			setMessage('이 지도 버전에서는 완료 버튼을 사용할 수 없습니다. 마우스 오른쪽 버튼으로 완료하세요.');
			return;
		}
		try {
			// 진행 중인 그리기가 없으면 엔진에서 아무 동작도 하지 않는다.
			objectManager.completeDrawing();
			measureState = 'completed';
			renderSummary();
			setMessage('완료 처리를 요청했습니다. 결과 라벨을 확인하고, 다시 측정하려면 "새 측정"을 누르세요.');
		} catch (e) {
			console.warn('[GIS 3D 지도] 실험적 완료 처리 실패', e);
			cancelDrawing();
			setMessage('완료 처리에 실패해 그리기를 취소했습니다. "새 측정"으로 다시 시작하세요.');
		}
	}

	function resetResults() {
		cancelDrawing();
		if (map && typeof map.clear === 'function') {
			try {
				map.clear();
			} catch (e) {
				console.warn('[GIS 3D 지도] 측정 결과 초기화 중 오류', e);
				setMessage('측정 결과를 초기화하지 못했습니다.');
				return;
			}
			document.dispatchEvent(new CustomEvent('gis:measurereset'));
		}
		setMessage('측정 결과를 초기화했습니다.');
		if (MEASURE_MODES[mode]) {
			startMeasure();
			setMessage('측정 결과를 초기화했습니다. 새 측정을 시작하세요.');
		}
	}

	/* ---------- 좌표 조회 ---------- */

	function showCoordinate(cartographic) {
		if (!cartographic || !isFinite(cartographic.longitude) || !isFinite(cartographic.latitude)) {
			lastCoordText = '';
			el.coordResult.hidden = true;
			setMessage('좌표를 얻을 수 없는 위치입니다. 지표면이나 건물을 클릭하세요.');
			return;
		}
		var lon = (cartographic.longitude * 180 / Math.PI).toFixed(6);
		var lat = (cartographic.latitude * 180 / Math.PI).toFixed(6);
		var text = '경도 ' + lon + ', 위도 ' + lat;
		var height = cartographic.height;
		// 클릭한 표면(건물/지형)의 타원체고. 유효한 숫자일 때만 참고값으로 표시한다.
		if (typeof height === 'number' && isFinite(height) && height > -500 && height < 9000) {
			text += ' · 고도 약 ' + height.toFixed(1) + 'm (참고값: WGS84 타원체고, 해발고도 아님)';
		}
		lastCoordText = lat + ', ' + lon;
		el.coordText.textContent = text;
		el.coordResult.hidden = false;
		setMessage('');
		renderSummary();
	}

	function copyCoordinate() {
		if (!lastCoordText) {
			return;
		}
		var fallback = function () {
			try {
				var range = document.createRange();
				range.selectNodeContents(el.coordText);
				var selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
			} catch (e) {
				// 선택 실패 시 안내만 표시한다.
			}
			setMessage('자동 복사를 사용할 수 없습니다. 표시된 좌표를 선택해 복사하세요. (위도, 경도: ' + lastCoordText + ')');
		};
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(lastCoordText).then(function () {
				setMessage('좌표를 복사했습니다. (위도, 경도: ' + lastCoordText + ')');
			}, fallback);
		} else {
			fallback();
		}
	}

	function onMapClick(windowPosition, ecefPosition, cartographic) {
		if (mode === 'coord') {
			showCoordinate(cartographic);
		}
	}

	/* ---------- 모드 ---------- */

	function renderMode() {
		Array.prototype.forEach.call(el.buttons, function (button) {
			var active = button.getAttribute('data-mode') === mode;
			button.setAttribute('aria-pressed', String(active));
			button.classList.toggle('is-active', active);
		});

		var info = MODE_INFO[mode];
		var measuring = !!MEASURE_MODES[mode];
		el.bar.hidden = !info;
		el.bar.setAttribute('data-mode', mode);
		if (!info) {
			renderSummary();
			return;
		}
		var touch = isTouchDevice();
		el.title.textContent = info.title;
		el.guide.textContent = touch ? info.touchGuide : info.guide;
		el.notice.textContent = info.notice;
		el.coordResult.hidden = true;
		el.complete.hidden = !(measuring && touch);
		el.restart.hidden = !measuring;
		el.cancel.hidden = !measuring;
		el.barReset.hidden = !measuring;
		setMessage(measuring && touch
			? '터치 기기의 완료 버튼은 실험적 기능이며 동작이 검증되지 않았습니다.'
			: '');
		renderSummary();
	}

	/* ---------- 공통 패널 접기/펼치기 ---------- */

	// 접힌 패널의 한 줄 요약. 측정값/지점 수는 VWorld 내부 라벨이라 알 수 없으므로 진행 상태와 사용 방법만 보여 준다.
	function summaryText() {
		if (MEASURE_MODES[mode]) {
			if (measureState === 'cancelled') {
				return '그리기 취소됨 · 펼쳐서 "새 측정"으로 다시 시작';
			}
			if (measureState === 'completed') {
				return '완료 처리됨 · 펼쳐서 "새 측정"으로 다시 시작';
			}
			if (measureState === 'failed') {
				return '측정을 시작하지 못함 · 펼쳐서 안내 확인';
			}
			return isTouchDevice()
				? '측정 중 · 탭: 지점 추가, 펼쳐서 "완료" 버튼 사용'
				: '측정 중 · 클릭: 지점 추가, 오른쪽 버튼: 완료';
		}
		if (mode === 'coord') {
			return lastCoordText ? '위도, 경도 ' + lastCoordText : '지도를 클릭하면 좌표를 표시합니다';
		}
		return externalSummaries[mode] || '';
	}

	function renderSummary() {
		if (!el.summary) {
			return;
		}
		var visible = collapsed && !!MODE_INFO[mode];
		el.summary.hidden = !visible;
		el.summary.textContent = visible ? summaryText() : '';
	}

	// 표시만 바꾼다: 지도 모드, 측정 결과, 분석 결과, 검색 마커, 저장본은 그대로이고 API도 호출하지 않는다.
	function setCollapsed(value) {
		collapsed = !!value;
		el.bar.classList.toggle('is-collapsed', collapsed);
		if (el.toggle) {
			el.toggle.setAttribute('aria-expanded', String(!collapsed));
			el.toggle.setAttribute('aria-label', collapsed ? '지도 도구 패널 펼치기' : '지도 도구 패널 접기');
			// 버튼의 접근성 이름은 aria-label이 정하므로 화살표는 보이는 문구에만 쓴다.
			el.toggle.textContent = collapsed ? '펼치기 \u25BC' : '접기 \u25B2';
		}
		renderSummary();
	}

	function setMode(next) {
		if (!MODE_INFO[next] && next !== 'select') {
			return;
		}
		if (!map || next === mode) {
			if (window.gisLayout) {
				window.gisLayout.closePanels();
			}
			return;
		}
		var previous = mode;
		if (MEASURE_MODES[previous]) {
			cancelDrawing();
		}
		mode = next;
		lastCoordText = '';
		measureState = '';
		renderMode();
		if (MEASURE_MODES[mode]) {
			if (isTouchDevice()) {
				// 터치 기기는 "완료 (실험적)" 버튼으로만 측정을 끝낼 수 있으므로 패널을 펼친다.
				setCollapsed(false);
			}
			startMeasure();
		}
		document.dispatchEvent(new CustomEvent('gis:modechange', { detail: { mode: mode, previous: previous } }));
		if (window.gisLayout) {
			window.gisLayout.closePanels();
		}
	}

	window.gisTools = {
		getMode: function () {
			return mode;
		},
		setMode: setMode,
		// 공통 패널 접기/펼치기 (map-analysis.js의 자동 펼침에서 사용)
		setCollapsed: setCollapsed,
		isCollapsed: function () {
			return collapsed;
		}
	};

	/* ---------- 초기화 ---------- */

	function register(readyMap) {
		if (registered || !readyMap) {
			return;
		}
		registered = true;
		map = readyMap;

		var clickSupported = !!(map.onClick && typeof map.onClick.addEventListener === 'function');
		if (clickSupported) {
			map.onClick.addEventListener(onMapClick);
		}
		Array.prototype.forEach.call(el.buttons, function (button) {
			var buttonMode = button.getAttribute('data-mode');
			var available = buttonMode === 'select'
				|| (buttonMode === 'coord' && clickSupported)
				|| (buttonMode === 'radius' && clickSupported && !!window.gisAnalysisRenderer
					&& window.gisAnalysisRenderer.isSupported())
				|| (MEASURE_MODES[buttonMode] && !!measureApi(buttonMode));
			button.disabled = !available;
		});
		el.reset.disabled = typeof map.clear !== 'function';
		if (el.hint) {
			el.hint.textContent = '측정 결과는 지도 위 VWorld 라벨로 표시되며 "측정 결과 초기화" 전까지 유지됩니다.';
		}
		// 버튼 활성 표시(is-active, aria-pressed)를 현재 모드와 맞춘다. 표시만 바꾸며 이벤트나 지도 API 호출은 없다.
		renderMode();
	}

	Array.prototype.forEach.call(el.buttons, function (button) {
		button.addEventListener('click', function () {
			setMode(button.getAttribute('data-mode'));
		});
	});
	el.reset.addEventListener('click', resetResults);
	el.barReset.addEventListener('click', resetResults);
	el.restart.addEventListener('click', function () {
		cancelDrawing();
		startMeasure();
	});
	el.cancel.addEventListener('click', function () {
		cancelDrawing();
		measureState = 'cancelled';
		setMessage('그리기를 취소했습니다. 다시 측정하려면 "새 측정"을 누르세요.');
		renderSummary();
	});
	if (el.toggle) {
		el.toggle.addEventListener('click', function () {
			setCollapsed(!collapsed);
		});
	}
	// 다른 모듈이 자기 모드의 요약 문구를 알려 준다. (map-analysis.js: 반경과 분석 상태)
	document.addEventListener('gis:toolbarsummary', function (event) {
		var detail = event.detail || {};
		if (detail.mode && MODE_INFO[detail.mode]) {
			externalSummaries[detail.mode] = detail.text || '';
			if (detail.mode === mode) {
				renderSummary();
			}
		}
	});
	el.complete.addEventListener('click', completeDrawingExperimental);
	el.coordCopy.addEventListener('click', copyCoordinate);
	el.exit.addEventListener('click', function () {
		setMode('select');
	});

	// 측정 모드에서는 오른쪽 버튼(완료)에 브라우저 메뉴가 뜨지 않도록 한다.
	if (el.mapEl) {
		el.mapEl.addEventListener('contextmenu', function (event) {
			if (MEASURE_MODES[mode]) {
				event.preventDefault();
			}
		});
	}
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && MEASURE_MODES[mode]) {
			cancelDrawing();
			measureState = 'cancelled';
			setMessage('그리기를 취소했습니다. 다시 측정하려면 "새 측정"을 누르세요.');
			renderSummary();
		}
	});

	document.addEventListener('gis:mapready', function (event) {
		register(event.detail && event.detail.map);
	});
	if (window.gisMap) {
		register(window.gisMap);
	}
})();
