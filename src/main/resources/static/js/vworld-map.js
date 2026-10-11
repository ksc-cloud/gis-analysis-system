/*
 * GIS 3D 지도 - VWorld 3D Map API 3.0 초기화
 *
 * 로딩 순서(index.jsp): jQuery -> webglMapInit.js.do(하위 스크립트를 document.write로 삽입) -> 이 파일
 * 초기화: new vw.Map() -> setOption({ mapId, initPosition, ... }) -> start()
 *         초기화가 끝나면 VWorld가 vw.ws3dInitCallBack을 호출한다.
 */
(function () {
	'use strict';

	var MAP_ID = 'map';
	var INIT_TIMEOUT_MS = 30000;

	// vw.Direction(heading, tilt, roll), vw.CoordZ(경도, 위도, 고도[m])
	var POSITIONS = {
		korea: { lon: 127.7, lat: 36.0, alt: 1100000, heading: 0, tilt: -90, roll: 0 },
		seoul: { lon: 126.978, lat: 37.562, alt: 1500, heading: 0, tilt: -45, roll: 0 }
	};

	var statusEl = document.getElementById('map-status');
	var statusTitleEl = document.getElementById('map-status-title');
	var statusTextEl = document.getElementById('map-status-text');
	var quickMoveButtons = document.querySelectorAll('#quick-move [data-move]');
	var quickMoveHint = document.getElementById('quick-move-hint');

	var map = null;
	var initTimer = null;

	function showStatus(state, title, text) {
		if (!statusEl) {
			return;
		}
		statusEl.hidden = false;
		statusEl.setAttribute('data-state', state);
		statusTitleEl.textContent = title;
		statusTextEl.textContent = text || '';
	}

	function hideStatus() {
		if (statusEl) {
			statusEl.hidden = true;
			statusEl.setAttribute('data-state', 'ready');
		}
	}

	function fail(title, text, detail) {
		if (initTimer) {
			clearTimeout(initTimer);
			initTimer = null;
		}
		if (detail) {
			console.error('[GIS 3D 지도] ' + title, detail);
		} else {
			console.error('[GIS 3D 지도] ' + title);
		}
		showStatus('error', title, text);
	}

	function networkHint() {
		return navigator.onLine === false
			? '인터넷 연결이 끊어져 있습니다. 네트워크 연결을 확인하세요.'
			: '네트워크 연결 상태와 VWorld 서비스 접속 가능 여부를 확인한 뒤 새로고침하세요.';
	}

	function hasWebGL() {
		try {
			var canvas = document.createElement('canvas');
			return !!(window.WebGLRenderingContext
				&& (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
		} catch (e) {
			return false;
		}
	}

	function scriptErrors() {
		return window.gisScriptErrors || [];
	}

	function cameraPosition(p) {
		return new vw.CameraPosition(new vw.CoordZ(p.lon, p.lat, p.alt), new vw.Direction(p.heading, p.tilt, p.roll));
	}

	function enableQuickMove() {
		Array.prototype.forEach.call(quickMoveButtons, function (button) {
			button.disabled = false;
			button.addEventListener('click', function () {
				var position = POSITIONS[button.getAttribute('data-move')];
				if (map && position) {
					map.moveTo(cameraPosition(position));
				}
			});
		});
		if (quickMoveHint) {
			quickMoveHint.textContent = '서울 도심으로 이동한 뒤 확대하면 3D 건물을 확인할 수 있습니다.';
		}
	}

	function onMapReady() {
		if (initTimer) {
			clearTimeout(initTimer);
			initTimer = null;
		}
		hideStatus();
		enableQuickMove();
		// 이후 단계(건물 정보 조회 등)에서 사용할 수 있도록 지도 객체를 노출하고 준비 완료를 알린다.
		window.gisMap = map;
		document.dispatchEvent(new CustomEvent('gis:mapready', { detail: { map: map } }));
	}

	// 패널 토글/창 크기 변경 시 다시 그리도록 요청한다. (Cesium 공개 API, 존재할 때만 호출)
	function requestRender() {
		try {
			if (window.ws3d && ws3d.viewer && ws3d.viewer.scene && typeof ws3d.viewer.scene.requestRender === 'function') {
				ws3d.viewer.scene.requestRender();
			}
		} catch (e) {
			// 렌더 요청 실패는 지도 사용에 영향이 없으므로 무시한다.
		}
	}

	function init() {
		var errors = scriptErrors();

		if (errors.indexOf('vworld') !== -1 || typeof window.vworldApiKey === 'undefined') {
			fail('VWorld API 스크립트를 불러오지 못했습니다.', networkHint());
			return;
		}

		// 잘못된 키이면 VWorld 로더가 vworldIsValid='false'와 vworldErrMsg를 내려준다.
		if (String(window.vworldIsValid) === 'false') {
			fail('VWorld API 키가 유효하지 않습니다.',
				(window.vworldErrMsg ? window.vworldErrMsg + ' ' : '')
				+ 'API 키 값과 VWorld에 등록한 서비스 URL이 현재 접속 주소와 일치하는지 확인하세요.');
			return;
		}

		if (errors.indexOf('jquery') !== -1 || typeof window.jQuery === 'undefined') {
			fail('jQuery를 불러오지 못했습니다.', 'VWorld 3D 지도는 jQuery가 필요합니다. ' + networkHint());
			return;
		}

		if (!window.vw || typeof vw.Map !== 'function' || !window.ws3d) {
			fail('VWorld 3D 지도 엔진을 불러오지 못했습니다.', networkHint());
			return;
		}

		if (!hasWebGL()) {
			fail('이 브라우저에서는 WebGL을 사용할 수 없습니다.',
				'3D 지도를 표시하려면 WebGL을 지원하는 최신 브라우저를 사용하고, 브라우저 설정에서 하드웨어 가속을 켜세요.');
			return;
		}

		try {
			map = new vw.Map();
			map.setOption({
				mapId: MAP_ID,
				initPosition: cameraPosition(POSITIONS.korea),
				logo: true,
				// 오른쪽 VWorld 조작 막대(나침반, 현재위치, 확대·축소, 초기화면, 이동컨트롤)는 유지한다.
				navigation: true,
				// 막대의 거리·면적·높이·초기화 묶음은 만들지 않는다. (VWViewerStartup.v30: new vw.NavigationZoom(el, isZoomControl))
				// 측정은 왼쪽 지도 도구가 유일한 진입점이고, 막대의 초기화(vw.Map.clear)는 분석 도형 복원 없이 모두 지우기 때문이다.
				isZoomControl: true
			});
			vw.ws3dInitCallBack = onMapReady;
			initTimer = setTimeout(function () {
				fail('3D 지도 초기화가 지연되고 있습니다.',
					'VWorld 서버 응답이 없거나 API 키 인증에 실패했을 수 있습니다. 브라우저 콘솔을 확인한 뒤 새로고침하세요.');
			}, INIT_TIMEOUT_MS);
			map.start();
		} catch (e) {
			fail('3D 지도 초기화에 실패했습니다.', '브라우저 콘솔의 오류 내용을 확인하세요.', e);
		}
	}

	window.addEventListener('resize', requestRender);

	init();
})();
