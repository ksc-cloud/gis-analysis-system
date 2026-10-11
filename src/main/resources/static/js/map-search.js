/*
 * GIS 3D 지도 - 지도 검색 (장소·건물명 / 도로명 주소 / 지번 주소)
 *
 * - 검색은 서버(/api/search)가 VWorld 검색 API 2.0을 대신 호출한다. (API 키는 브라우저에 추가로 노출하지 않음)
 * - 흐름: 검색어 입력 -> 검색 요청(이전 요청 취소, 늦은 응답 무시) -> 결과 목록(페이지 이동) -> 결과 선택
 *         -> 카메라 이동 + 검색 위치 마커 -> 필요하면 "이 위치로 반경 분석"(중심점만 지정, 분석은 사용자가 실행)
 * - 검색 위치 마커는 이 모듈이 따로 관리한다. 항상 하나만 그리고(새로 고르면 교체), "검색 위치 지우기"로만 지운다.
 *   분석 초기화/저장본 표시는 마커를 건드리지 않는다. 측정 결과 초기화(vw.Map.clear)로 지워지면
 *   'gis:measurereset' 이벤트를 받아 다시 그린다.
 * - 검색은 지도 모드를 바꾸지 않는다. (건물 선택, 측정, 반경 분석 등 현재 모드 유지)
 * - 결과 문자열은 모두 textContent로만 넣는다.
 */
(function () {
	'use strict';

	var MIN_QUERY = 2;
	var MAX_QUERY = 100;
	var CAMERA_HEIGHT = 700;

	var script = document.currentScript;
	var API_URL = (script && script.getAttribute('data-api-url')) || '/api/search';

	var el = {
		form: document.getElementById('map-search-form'),
		type: document.getElementById('map-search-type'),
		input: document.getElementById('map-search-input'),
		button: document.getElementById('map-search-button'),
		hint: document.getElementById('map-search-hint'),
		status: document.getElementById('map-search-status'),
		results: document.getElementById('map-search-results'),
		pager: document.getElementById('map-search-pager'),
		prev: document.getElementById('map-search-prev'),
		next: document.getElementById('map-search-next'),
		page: document.getElementById('map-search-page'),
		selected: document.getElementById('map-search-selected'),
		selectedText: document.getElementById('map-search-selected-text'),
		radius: document.getElementById('map-search-radius'),
		clear: document.getElementById('map-search-clear')
	};

	if (!el.form || !el.input || !el.button || !el.results) {
		return;
	}

	var TYPE_LABELS = { place: '장소·건물명', road: '도로명 주소', parcel: '지번 주소' };

	var map = null;
	var registered = false;
	var search = {
		query: null,
		type: 'place',
		page: 1,
		totalPages: 0,
		totalCount: 0,
		items: [],
		seq: 0,
		controller: null,
		loading: false
	};
	var marker = { spec: null, obj: null, item: null };

	/* ---------- 공통 ---------- */

	function show(node, visible) {
		if (node) {
			node.hidden = !visible;
		}
	}

	function setStatus(text, kind) {
		el.status.textContent = text || '';
		el.status.className = 'search__status' + (kind ? ' is-' + kind : '');
		show(el.status, !!text);
	}

	function shorten(text, max) {
		var chars = Array.from(String(text));
		return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
	}

	function isMobile() {
		return !!(window.gisLayout && window.gisLayout.isMobile());
	}

	// 서버 규칙과 같게: 앞뒤 공백 제거 후 2~100자(코드포인트), 제어 문자 없음
	function normalizeQuery(value) {
		var query = String(value == null ? '' : value).trim();
		var chars = Array.from(query);
		var invalid = chars.some(function (ch) {
			return /^[\u0000-\u001f\u007f-\u009f]$/.test(ch) || /^[\ud800-\udfff]$/.test(ch);
		});
		return chars.length >= MIN_QUERY && chars.length <= MAX_QUERY && !invalid ? query : null;
	}

	// 서버 연결 실패, 서버 오류, VWorld(외부 API) 오류를 구분한다.
	function errorText(res) {
		if (res.network) {
			return navigator.onLine === false
				? '인터넷 연결이 끊어져 검색할 수 없습니다.'
				: '서버에 연결할 수 없어 검색하지 못했습니다. 서버가 실행 중인지 확인하세요.';
		}
		var code = res.body && res.body.error;
		if (res.status === 400) {
			return (res.body && res.body.message) || '검색 조건이 올바르지 않습니다.';
		}
		if (res.status === 503 && code === 'API_KEY_MISSING') {
			return '서버에 VWorld API 키가 설정되지 않아 검색할 수 없습니다.';
		}
		if (res.status === 504) {
			return 'VWorld 검색 서비스의 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.';
		}
		if (res.status === 502) {
			return 'VWorld 검색 서비스에서 오류가 발생했습니다.' + (res.body && res.body.vworldErrorCode
				? ' (' + res.body.vworldErrorCode + ')' : '') + ' 잠시 후 다시 시도하세요.';
		}
		return '서버 오류로 검색하지 못했습니다. (HTTP ' + res.status + ')';
	}

	/* ---------- 검색 ---------- */

	function setLoading(loading) {
		search.loading = loading;
		el.button.textContent = loading ? '검색 중...' : '검색';
		el.form.setAttribute('aria-busy', String(loading));
	}

	function submit(event) {
		if (event && typeof event.preventDefault === 'function') {
			event.preventDefault();
		}
		if (!registered) {
			return;
		}
		var query = normalizeQuery(el.input.value);
		if (query === null) {
			setStatus('검색어는 앞뒤 공백을 빼고 ' + MIN_QUERY + '~' + MAX_QUERY + '자로 입력하세요.', 'error');
			return;
		}
		search.query = query;
		search.type = TYPE_LABELS[el.type && el.type.value] ? el.type.value : 'place';
		search.page = 1;
		run();
	}

	function run() {
		if (search.controller) {
			search.controller.abort();
		}
		var seq = ++search.seq;
		var controller = typeof AbortController === 'function' ? new AbortController() : null;
		search.controller = controller;
		setLoading(true);
		setStatus(TYPE_LABELS[search.type] + '에서 "' + search.query + '"을(를) 검색하고 있습니다...', 'info');
		var url = API_URL + '?query=' + encodeURIComponent(search.query) + '&type=' + encodeURIComponent(search.type)
			+ '&page=' + encodeURIComponent(search.page);
		fetch(url, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
			.then(function (response) {
				return response.json().catch(function () { return null; }).then(function (body) {
					return { ok: response.ok, status: response.status, body: body };
				});
			}, function (error) {
				return { ok: false, network: true, aborted: !!(error && error.name === 'AbortError') };
			})
			.then(function (res) {
				if (seq !== search.seq || res.aborted) {
					return; // 더 최근 검색으로 대체됨
				}
				search.controller = null;
				setLoading(false);
				if (!res.ok || !res.body || !Array.isArray(res.body.items)) {
					search.items = [];
					renderResults();
					setStatus(res.ok ? '검색 응답 형식을 확인할 수 없습니다.' : errorText(res), 'error');
					return;
				}
				search.items = res.body.items.filter(function (item) {
					return item && isFinite(item.lon) && isFinite(item.lat);
				});
				search.totalPages = res.body.totalPages || 0;
				search.totalCount = res.body.totalCount || 0;
				renderResults();
				if (!search.items.length) {
					setStatus('검색 결과가 없습니다. 검색 유형(장소·건물명 / 도로명 주소 / 지번 주소)을 바꾸거나 검색어를 확인하세요.', 'empty');
				} else {
					setStatus(TYPE_LABELS[search.type] + ' 검색 결과 ' + search.totalCount + '건', 'info');
				}
			});
	}

	function renderResults() {
		el.results.textContent = '';
		search.items.forEach(function (item, index) {
			el.results.appendChild(createItem(item, index));
		});
		var paged = search.items.length > 0 && search.totalPages > 1;
		show(el.pager, paged);
		if (el.page) {
			el.page.textContent = search.page + ' / ' + Math.max(1, search.totalPages);
		}
		if (el.prev) {
			el.prev.disabled = search.page <= 1;
		}
		if (el.next) {
			el.next.disabled = search.page >= search.totalPages;
		}
	}

	function isSameItem(a, b) {
		return !!(a && b && a.id === b.id && a.lon === b.lon && a.lat === b.lat && a.title === b.title);
	}

	function createItem(item, index) {
		var li = document.createElement('li');
		li.className = 'search__item' + (isSameItem(item, marker.item) ? ' is-selected' : '');
		var button = document.createElement('button');
		button.type = 'button';
		button.className = 'search__item-button';
		var title = document.createElement('strong');
		title.className = 'search__item-title';
		title.textContent = item.title;
		button.appendChild(title);
		if (item.category) {
			var category = document.createElement('span');
			category.className = 'search__item-category';
			category.textContent = item.category;
			button.appendChild(category);
		}
		if (item.subtitle) {
			var subtitle = document.createElement('span');
			subtitle.className = 'search__item-subtitle';
			subtitle.textContent = item.subtitle;
			button.appendChild(subtitle);
		}
		button.addEventListener('click', function () {
			select(index);
		});
		li.appendChild(button);
		return li;
	}

	/* ---------- 선택 / 마커 ---------- */

	function moveTo(item) {
		if (!map || typeof map.moveTo !== 'function' || !window.vw || typeof vw.CameraPosition !== 'function') {
			return false;
		}
		try {
			map.moveTo(new vw.CameraPosition(new vw.CoordZ(item.lon, item.lat, CAMERA_HEIGHT), new vw.Direction(0, -90, 0)));
			return true;
		} catch (e) {
			console.warn('[GIS 3D 지도] 검색 위치로 이동 실패', e);
			return false;
		}
	}

	function removeMarkerObject() {
		if (!marker.obj) {
			return;
		}
		try {
			if (map && typeof map.removeObject === 'function') {
				map.removeObject(marker.obj);
			}
		} catch (e) {
			console.warn('[GIS 3D 지도] 검색 위치 마커 삭제 중 오류', e);
		}
		marker.obj = null;
	}

	function buildMarker() {
		marker.obj = null;
		if (!marker.spec || !window.vw || !vw.geom || typeof vw.geom.PointZ !== 'function' || typeof vw.CoordZ !== 'function') {
			return false;
		}
		try {
			var obj = new vw.geom.PointZ(new vw.CoordZ(marker.spec.lon, marker.spec.lat, 0));
			obj.setName(marker.spec.label);
			if (typeof obj.setFont === 'function') {
				obj.setFont('sans-serif');
			}
			if (typeof obj.setFontSize === 'function') {
				obj.setFontSize(14);
			}
			obj.create();
			marker.obj = obj;
			return true;
		} catch (e) {
			console.warn('[GIS 3D 지도] 검색 위치 마커 생성 실패', e);
			return false;
		}
	}

	function select(index) {
		var item = search.items[index];
		if (!item) {
			return;
		}
		// 마커는 하나만: 이전 마커를 지우고 새로 그린다.
		removeMarkerObject();
		marker.item = item;
		marker.spec = { lon: item.lon, lat: item.lat, label: '검색 위치 · ' + shorten(item.title, 30) };
		var drawn = buildMarker();
		var moved = moveTo(item);
		renderResults();
		show(el.selected, true);
		el.selectedText.textContent = item.title + (item.subtitle ? ' (' + item.subtitle + ')' : '');
		setStatus('"' + item.title + '" 위치로 이동했습니다.' + (moved ? '' : ' (지도 이동 실패)')
			+ (drawn ? '' : ' (위치 표시 실패)'), moved ? 'info' : 'error');
		if (isMobile() && window.gisLayout) {
			window.gisLayout.closePanels();
		}
	}

	function clearMarker() {
		removeMarkerObject();
		marker.spec = null;
		marker.item = null;
		show(el.selected, false);
		el.selectedText.textContent = '';
		renderResults();
		setStatus('검색 위치 표시를 지웠습니다.', 'info');
	}

	function startRadius() {
		if (!marker.item) {
			return;
		}
		var analysis = window.gisAnalysis;
		var ok = !!(analysis && typeof analysis.startAt === 'function'
			&& analysis.startAt({ lon: marker.item.lon, lat: marker.item.lat }));
		setStatus(ok
			? '반경 분석 모드로 전환하고 검색 위치를 중심점으로 정했습니다. 반경을 확인한 뒤 지도 위 "분석 실행"을 누르세요.'
			: '이 위치로 반경 분석을 시작할 수 없습니다. (지도 또는 반경 분석 기능을 사용할 수 없는 상태)', ok ? 'info' : 'error');
	}

	/* ---------- 초기화 / 이벤트 ---------- */

	function register(readyMap) {
		if (registered || !readyMap) {
			return;
		}
		registered = true;
		map = readyMap;
		el.input.disabled = false;
		el.button.disabled = false;
		if (el.type) {
			el.type.disabled = false;
		}
		if (el.hint) {
			el.hint.textContent = '검색 유형을 고른 뒤 검색어를 입력하세요. 건물명은 "장소·건물명"에서 찾을 수 있습니다.';
		}
	}

	el.form.addEventListener('submit', submit);
	if (el.prev) {
		el.prev.addEventListener('click', function () {
			if (search.query && search.page > 1) {
				search.page--;
				run();
			}
		});
	}
	if (el.next) {
		el.next.addEventListener('click', function () {
			if (search.query && search.page < search.totalPages) {
				search.page++;
				run();
			}
		});
	}
	if (el.clear) {
		el.clear.addEventListener('click', clearMarker);
	}
	if (el.radius) {
		el.radius.addEventListener('click', startRadius);
	}
	// 측정 결과 초기화(vw.Map.clear)로 지워진 검색 위치 마커를 다시 그린다.
	document.addEventListener('gis:measurereset', function () {
		if (marker.spec) {
			buildMarker();
		}
	});
	document.addEventListener('gis:mapready', function (event) {
		register(event.detail && event.detail.map);
	});
	if (window.gisMap) {
		register(window.gisMap);
	}

	window.gisSearch = {
		getState: function () {
			return {
				query: search.query, type: search.type, page: search.page, totalPages: search.totalPages,
				loading: search.loading, items: search.items.length,
				marker: marker.spec ? { lon: marker.spec.lon, lat: marker.spec.lat, label: marker.spec.label, drawn: !!marker.obj } : null
			};
		}
	};
})();
