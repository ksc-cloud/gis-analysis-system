/*
 * GIS 3D 지도 - 분석 결과 저장과 분석 이력 (7단계)
 *
 * /api/analyses 통신은 이 파일만 담당한다.
 *   POST   /api/analyses        {analysisToken, title} : 반경 분석 응답의 토큰으로 서버가 보관한 결과를 저장
 *   GET    /api/analyses        ?page&size&sort        : 이력 목록
 *   GET    /api/analyses/{id}                          : 저장된 결과(6단계 결과와 같은 구조) - VWorld 재조회 없음
 *   DELETE /api/analyses/{id}
 * - 결과 표시는 map-analysis.js(window.gisAnalysis)의 화면을 그대로 쓴다. (showSaved / clearSaved / showTab)
 * - 'gis:analysisresult' 이벤트로 현재 결과를 받아 저장 폼을 연다. 실시간 결과일 때만 저장할 수 있다.
 * - 저장되면(이미 저장된 경우 포함) 서버가 스냅샷 토큰을 지우므로 'gis:analysissaved' 이벤트
 *   { generation, analysisId, title }를 보내 공간 통계(spatial-dashboard.js)가 저장된 분석 ID로 전환하게 한다.
 * - 저장 요청은 취소하지 않는다. 요청 중에 새 분석이 시작되어도 서버 저장은 끝까지 진행하고(이력 유실 방지),
 *   응답은 그 요청을 보낸 결과(generation)가 아직 화면에 있을 때만 저장 폼에 반영한다.
 * - 서버 연결 실패(fetch 실패)와 DB 연결 실패(503 DB_UNAVAILABLE)를 구분해 안내한다.
 * - 외부 문자열(제목 등)은 모두 textContent로만 넣는다.
 */
(function () {
	'use strict';

	var PAGE_SIZE = 10;
	var MAX_TITLE = 100;
	var MAX_HISTORY = 500;

	var script = document.currentScript;
	var API_URL = (script && script.getAttribute('data-api-url')) || '/api/analyses';

	var el = {
		saveForm: document.getElementById('analysis-save'),
		saveTitle: document.getElementById('analysis-save-title'),
		saveCount: document.getElementById('analysis-save-count'),
		saveButton: document.getElementById('analysis-save-button'),
		saveStatus: document.getElementById('analysis-save-status'),
		saveOpenHistory: document.getElementById('analysis-save-open-history'),
		section: document.getElementById('history-section'),
		refresh: document.getElementById('history-refresh'),
		sort: document.getElementById('history-sort'),
		total: document.getElementById('history-total'),
		status: document.getElementById('history-status'),
		retry: document.getElementById('history-retry'),
		empty: document.getElementById('history-empty'),
		list: document.getElementById('history-list'),
		pager: document.getElementById('history-pager'),
		prev: document.getElementById('history-prev'),
		next: document.getElementById('history-next'),
		page: document.getElementById('history-page')
	};

	var analysis = window.gisAnalysis;
	if (!el.saveForm || !el.saveButton || !el.section || !el.list || !analysis || !analysis.showSaved) {
		return;
	}

	var MESSAGES = {
		INVALID_TITLE: '제목은 앞뒤 공백을 빼고 1~' + MAX_TITLE + '자로 입력하세요. 줄바꿈 같은 제어 문자는 쓸 수 없습니다.',
		INVALID_TOKEN: '저장할 분석 정보가 올바르지 않습니다. 반경 분석을 다시 실행한 뒤 저장하세요.',
		INVALID_REQUEST: '요청 형식이 올바르지 않습니다. 페이지를 새로 고친 뒤 다시 시도하세요.',
		UNSUPPORTED_MEDIA_TYPE: '요청 형식이 올바르지 않습니다. 페이지를 새로 고친 뒤 다시 시도하세요.',
		INVALID_PAGE: '목록 페이지 값이 올바르지 않습니다.',
		INVALID_SORT: '목록 정렬 값이 올바르지 않습니다.',
		INVALID_ID: '분석 이력 번호가 올바르지 않습니다.',
		ANALYSIS_NOT_FOUND: '이미 삭제되었거나 없는 분석 이력입니다.',
		ALREADY_SAVED: '이미 저장된 분석 결과입니다.',
		HISTORY_LIMIT: '분석 이력은 최대 ' + MAX_HISTORY + '건까지 저장할 수 있습니다. "분석 이력" 탭에서 필요 없는 이력을 삭제한 뒤 다시 저장하세요.',
		SNAPSHOT_EXPIRED: '저장 가능 시간(분석 후 30분)이 지났거나 서버가 다시 시작되어 이 결과는 저장할 수 없습니다. "분석 실행"으로 다시 분석한 뒤 저장하세요.',
		PAYLOAD_TOO_LARGE: '요청이 너무 큽니다. 제목을 줄여서 다시 시도하세요.',
		UNSUPPORTED_RESULT: '이 분석 결과에는 이력에 저장할 수 없는 값이 있습니다.',
		STORED_DATA_INVALID: '저장된 분석 데이터를 읽을 수 없습니다.',
		DB_UNAVAILABLE: '분석 이력 데이터베이스에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다. 잠시 후 다시 시도하세요.',
		DB_ERROR: '분석 이력 데이터베이스 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.'
	};

	// 응답 본문에 오류 코드가 없을 때(프록시/서버 기본 오류 페이지 등) 상태 코드로 판단한다.
	var STATUS_CODES = { 404: 'ANALYSIS_NOT_FOUND', 410: 'SNAPSHOT_EXPIRED', 413: 'PAYLOAD_TOO_LARGE',
		415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNSUPPORTED_RESULT', 503: 'DB_UNAVAILABLE' };

	var save = {
		generation: null, // 저장 폼이 가리키는 결과
		token: null,
		saving: false,
		finished: false // 저장됨/이미 저장됨/만료: 이 결과로 더 저장할 수 없음
	};

	var history = {
		loaded: false,
		stale: true,
		page: 1,
		sort: 'SAVED_DESC',
		totalItems: 0,
		totalPages: 0,
		items: [],
		listSeq: 0,
		listController: null,
		detailSeq: 0,
		detailController: null,
		openingId: null,
		deletingId: null,
		confirmingId: null,
		highlightId: null
	};

	/* ---------- 공통 ---------- */

	function show(node, visible) {
		if (node) {
			node.hidden = !visible;
		}
	}

	// 서버 연결 실패: network, 응답은 왔지만 오류: ok=false, 취소: aborted
	function request(method, url, body, controller) {
		var headers = { Accept: 'application/json' };
		if (body) {
			headers['Content-Type'] = 'application/json';
		}
		return fetch(url, {
			method: method,
			headers: headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: controller ? controller.signal : undefined
		}).then(function (response) {
			if (response.status === 204) {
				return { ok: true, status: 204, body: null };
			}
			return response.json().catch(function () { return null; }).then(function (data) {
				return { ok: response.ok, status: response.status, body: data };
			});
		}, function (error) {
			return { ok: false, network: true, aborted: !!(error && error.name === 'AbortError') };
		});
	}

	function errorCode(res) {
		if (res.body && typeof res.body.error === 'string') {
			return res.body.error;
		}
		return STATUS_CODES[res.status] || null;
	}

	function errorText(res) {
		if (res.network) {
			return navigator.onLine === false
				? '인터넷 연결이 끊어져 서버에 연결할 수 없습니다.'
				: '서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 다시 시도하세요. (DB 문제가 아니라 서버와의 연결 문제입니다)';
		}
		var code = errorCode(res);
		if (code && MESSAGES[code]) {
			return MESSAGES[code];
		}
		return res.status >= 500
			? '서버 오류가 발생했습니다. (HTTP ' + res.status + ') 잠시 후 다시 시도하세요.'
			: '요청을 처리하지 못했습니다. (HTTP ' + res.status + ')';
	}

	function newController() {
		return typeof AbortController === 'function' ? new AbortController() : null;
	}

	function formatDate(iso) {
		return analysis.formatDateTime ? analysis.formatDateTime(iso) : String(iso);
	}

	function formatRadius(r) {
		return analysis.formatRadius ? analysis.formatRadius(r) : r + 'm';
	}

	function codePoints(text) {
		return Array.from(text);
	}

	/* ---------- 저장 ---------- */

	// 서버 규칙과 같게: 앞뒤 공백 제거 후 1~100자(코드포인트), 제어 문자/깨진 문자 없음
	function normalizeTitle(value) {
		var title = String(value == null ? '' : value).trim();
		var chars = codePoints(title);
		var invalid = chars.some(function (ch) {
			return /^[\u0000-\u001f\u007f-\u009f]$/.test(ch) || /^[\ud800-\udfff]$/.test(ch);
		});
		return chars.length >= 1 && chars.length <= MAX_TITLE && !invalid ? title : null;
	}

	function updateCount() {
		if (el.saveCount) {
			var n = codePoints(String(el.saveTitle.value).trim()).length;
			el.saveCount.textContent = n + ' / ' + MAX_TITLE;
			el.saveCount.classList.toggle('is-over', n > MAX_TITLE);
		}
	}

	function setSaveStatus(text, kind) {
		el.saveStatus.textContent = text || '';
		el.saveStatus.className = 'analysis-save__status' + (kind ? ' is-' + kind : '');
		show(el.saveStatus, !!text);
	}

	function renderSaveControls() {
		el.saveButton.disabled = save.saving || save.finished || !save.token;
		el.saveTitle.disabled = save.saving || save.finished;
		el.saveButton.textContent = save.saving ? '저장 중...' : (save.finished ? '저장 완료' : '분석 결과 저장');
		el.saveForm.setAttribute('aria-busy', String(save.saving));
	}

	function defaultTitle(cur) {
		return '반경 ' + formatRadius(cur.radius) + ' · ' + formatDate(cur.analyzedAt || new Date().toISOString());
	}

	function onAnalysisResult(cur) {
		var live = cur && cur.source === 'live' && cur.analysisToken;
		save.generation = cur ? cur.generation : null;
		save.token = live ? cur.analysisToken : null;
		save.saving = false; // 새 결과의 폼 상태 (이전 결과의 요청은 계속 진행되고 응답은 따로 처리)
		save.finished = false;
		show(el.saveForm, !!live);
		show(el.saveOpenHistory, false);
		setSaveStatus('', null);
		if (live) {
			el.saveTitle.value = defaultTitle(cur);
			updateCount();
		}
		renderSaveControls();
		if (history.loaded) {
			renderList(); // 지도에 표시 중인 저장본 표시(is-current) 갱신
		}
	}

	function submitSave(event) {
		if (event && typeof event.preventDefault === 'function') {
			event.preventDefault();
		}
		if (save.saving || save.finished || !save.token) {
			return; // 이중 클릭/중복 제출 방지
		}
		var title = normalizeTitle(el.saveTitle.value);
		if (title === null) {
			setSaveStatus(MESSAGES.INVALID_TITLE, 'error');
			if (typeof el.saveTitle.focus === 'function') {
				el.saveTitle.focus();
			}
			return;
		}
		var target = { generation: save.generation, token: save.token, title: title };
		save.saving = true;
		setSaveStatus('저장하고 있습니다...', 'info');
		show(el.saveOpenHistory, false);
		renderSaveControls();
		request('POST', API_URL, { analysisToken: target.token, title: title }, null).then(function (res) {
			var stillShown = save.generation === target.generation;
			var code = res.ok ? null : errorCode(res);
			var storedId = res.ok && res.body ? res.body.analysisId : (code === 'ALREADY_SAVED' && res.body ? res.body.analysisId : null);
			if (res.ok || code === 'ALREADY_SAVED') {
				markHistoryStale(storedId);
				if (storedId != null) {
					document.dispatchEvent(new CustomEvent('gis:analysissaved', {
						detail: { generation: target.generation, analysisId: storedId, title: res.ok ? target.title : null }
					}));
				}
			}
			if (!stillShown) {
				// 저장 요청 중 다른 결과로 바뀌었다: 새 결과의 폼은 건드리지 않고 이력 탭에만 알린다.
				setHistoryStatus(res.ok
					? '이전 분석 결과를 저장했습니다: "' + target.title + '"'
					: '이전 분석 결과를 저장하지 못했습니다: ' + errorText(res), res.ok ? 'info' : 'error');
				return;
			}
			save.saving = false;
			if (res.ok) {
				save.finished = true;
				setSaveStatus('저장했습니다. (이력 #' + storedId + ')', 'success');
				el.saveOpenHistory.textContent = '분석 이력에서 보기';
				show(el.saveOpenHistory, true);
			} else if (code === 'ALREADY_SAVED') {
				save.finished = true;
				setSaveStatus(MESSAGES.ALREADY_SAVED + (storedId != null ? ' (이력 #' + storedId + ')' : ''), 'success');
				el.saveOpenHistory.textContent = '분석 이력에서 보기';
				show(el.saveOpenHistory, true);
			} else {
				if (code === 'SNAPSHOT_EXPIRED' || code === 'INVALID_TOKEN' || code === 'UNSUPPORTED_RESULT') {
					save.finished = true; // 같은 토큰으로는 다시 저장할 수 없다.
				}
				setSaveStatus(errorText(res), 'error');
				if (code === 'HISTORY_LIMIT') {
					el.saveOpenHistory.textContent = '분석 이력 정리하기';
					show(el.saveOpenHistory, true);
				}
			}
			renderSaveControls();
		});
	}

	/* ---------- 이력 목록 ---------- */

	function setHistoryStatus(text, kind) {
		el.status.textContent = text || '';
		el.status.className = 'history__status' + (kind ? ' is-' + kind : '');
		show(el.status, !!text);
	}

	function isHistoryVisible() {
		return !el.section.hidden;
	}

	function markHistoryStale(highlightId) {
		history.stale = true;
		if (highlightId != null) {
			history.highlightId = highlightId;
		}
		if (isHistoryVisible()) {
			loadList();
		}
	}

	function loadList(statusAfter) {
		if (history.listController) {
			history.listController.abort();
		}
		var seq = ++history.listSeq;
		var controller = newController();
		history.listController = controller;
		el.section.setAttribute('data-state', 'loading');
		setHistoryStatus('분석 이력을 불러오고 있습니다...', 'info');
		show(el.retry, false);
		var url = API_URL + '?page=' + encodeURIComponent(history.page) + '&size=' + PAGE_SIZE
			+ '&sort=' + encodeURIComponent(history.sort);
		request('GET', url, null, controller).then(function (res) {
			if (seq !== history.listSeq || res.aborted) {
				return; // 더 최근 요청으로 대체됨
			}
			history.listController = null;
			if (!res.ok || !res.body || !Array.isArray(res.body.items)) {
				history.items = [];
				history.loaded = false;
				el.section.setAttribute('data-state', 'error');
				renderList();
				setHistoryStatus(res.ok ? '분석 이력 응답 형식을 확인할 수 없습니다.' : errorText(res), 'error');
				show(el.retry, true);
				return;
			}
			var body = res.body;
			if (!body.items.length && body.totalPages > 0 && history.page > body.totalPages) {
				// 마지막 페이지의 항목을 지워 페이지가 비었다: 마지막 페이지로 이동
				history.page = body.totalPages;
				loadList(statusAfter);
				return;
			}
			history.loaded = true;
			history.stale = false;
			history.items = body.items;
			history.totalItems = body.totalItems;
			history.totalPages = body.totalPages;
			el.section.setAttribute('data-state', body.items.length ? 'list' : 'empty');
			renderList();
			setHistoryStatus(statusAfter || '', statusAfter ? 'info' : null);
		});
	}

	function renderList() {
		el.list.textContent = '';
		var cur = analysis.getCurrent ? analysis.getCurrent() : null;
		var shownId = cur && cur.source === 'saved' ? cur.analysisId : null;
		history.items.forEach(function (item) {
			el.list.appendChild(createItem(item, item.analysisId === shownId));
		});
		show(el.empty, history.loaded && history.items.length === 0);
		el.total.textContent = history.loaded ? '총 ' + history.totalItems + '건 (최대 ' + MAX_HISTORY + '건)' : '';
		show(el.pager, history.loaded && history.totalPages > 1);
		el.page.textContent = history.page + ' / ' + Math.max(1, history.totalPages);
		el.prev.disabled = history.page <= 1;
		el.next.disabled = history.page >= history.totalPages;
	}

	function button(text, className, onClick) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = className;
		b.textContent = text;
		b.addEventListener('click', onClick);
		return b;
	}

	function createItem(item, isShown) {
		var id = item.analysisId;
		var li = document.createElement('li');
		li.className = 'history__item' + (isShown ? ' is-current' : '') + (id === history.highlightId ? ' is-highlight' : '');
		li.setAttribute('data-id', String(id));

		var head = document.createElement('div');
		head.className = 'history__item-head';
		var title = document.createElement('strong');
		title.className = 'history__item-title';
		title.textContent = item.title;
		var badge = document.createElement('span');
		badge.className = 'history__badge history__badge--' + (item.complete ? 'complete' : 'partial');
		badge.textContent = item.complete ? '완전한 결과' : '부분 결과';
		head.appendChild(title);
		head.appendChild(badge);
		if (isShown) {
			var shown = document.createElement('span');
			shown.className = 'history__badge history__badge--shown';
			shown.textContent = '지도에 표시 중';
			head.appendChild(shown);
		}

		var meta = document.createElement('p');
		meta.className = 'history__item-meta';
		meta.textContent = '반경 ' + formatRadius(item.radiusMeters) + ' · 건물 ' + item.buildingCount + '개'
			+ (item.complete ? '' : ' 이상') + ' · 저장 ' + formatDate(item.savedAt);

		var actions = document.createElement('div');
		actions.className = 'history__actions';
		var busy = history.openingId === id || history.deletingId === id;
		if (history.confirmingId === id) {
			var question = document.createElement('p');
			question.className = 'history__confirm';
			question.textContent = '이 이력을 삭제할까요? 삭제하면 되돌릴 수 없습니다.';
			actions.appendChild(question);
			var confirmButton = button(history.deletingId === id ? '삭제 중...' : '삭제', 'tool-bar__button history__danger',
				function () { deleteItem(id); });
			confirmButton.setAttribute('data-action', 'confirm-delete');
			confirmButton.disabled = busy;
			var cancel = button('취소', 'tool-bar__button', function () {
				history.confirmingId = null;
				renderList();
			});
			cancel.setAttribute('data-action', 'cancel-delete');
			cancel.disabled = busy;
			actions.appendChild(confirmButton);
			actions.appendChild(cancel);
		} else {
			var open = button(history.openingId === id ? '불러오는 중...' : '지도에서 보기', 'tool-bar__button tool-bar__button--primary',
				function () { openItem(id); });
			open.setAttribute('data-action', 'open');
			open.disabled = busy;
			var remove = button('삭제', 'tool-bar__button', function () {
				history.confirmingId = id;
				renderList();
			});
			remove.setAttribute('data-action', 'delete');
			remove.disabled = busy;
			actions.appendChild(open);
			actions.appendChild(remove);
		}

		li.appendChild(head);
		li.appendChild(meta);
		li.appendChild(actions);
		return li;
	}

	/* ---------- 다시 보기 / 삭제 ---------- */

	function openItem(id) {
		if (history.detailController) {
			history.detailController.abort();
		}
		var seq = ++history.detailSeq;
		var controller = newController();
		history.detailController = controller;
		history.openingId = id;
		history.confirmingId = null;
		renderList();
		setHistoryStatus('저장된 분석을 불러오고 있습니다...', 'info');
		request('GET', API_URL + '/' + encodeURIComponent(id), null, controller).then(function (res) {
			if (seq !== history.detailSeq || res.aborted) {
				return;
			}
			history.detailController = null;
			history.openingId = null;
			if (!res.ok) {
				// 실패해도 지금 지도에 표시된 결과는 그대로 둔다.
				setHistoryStatus(errorText(res), 'error');
				if (errorCode(res) === 'ANALYSIS_NOT_FOUND') {
					history.stale = true;
					if (isHistoryVisible()) {
						loadList(MESSAGES.ANALYSIS_NOT_FOUND);
						return;
					}
				}
				renderList();
				return;
			}
			history.highlightId = null;
			if (!analysis.showSaved(res.body)) {
				renderList();
				setHistoryStatus('저장된 분석 데이터를 표시할 수 없습니다.', 'error');
				return;
			}
			setHistoryStatus('"' + res.body.title + '"을(를) 지도에 표시했습니다.', 'info');
			renderList();
		});
	}

	function deleteItem(id) {
		if (history.deletingId !== null) {
			return;
		}
		history.deletingId = id;
		renderList();
		request('DELETE', API_URL + '/' + encodeURIComponent(id), null, null).then(function (res) {
			history.deletingId = null;
			var code = res.ok ? null : errorCode(res);
			if (res.ok || code === 'ANALYSIS_NOT_FOUND') {
				history.confirmingId = null;
				analysis.clearSaved(id);
				if (history.highlightId === id) {
					history.highlightId = null;
				}
				history.stale = true;
				loadList(res.ok ? '분석 이력을 삭제했습니다.' : '이미 삭제된 이력입니다. 목록을 새로 고쳤습니다.');
				return;
			}
			renderList();
			setHistoryStatus(errorText(res), 'error');
		});
	}

	/* ---------- 이벤트 ---------- */

	el.saveForm.addEventListener('submit', submitSave);
	el.saveTitle.addEventListener('input', function () {
		updateCount();
		if (el.saveStatus.className.indexOf('is-error') >= 0 && !save.saving) {
			setSaveStatus('', null);
		}
	});
	el.saveOpenHistory.addEventListener('click', function () {
		analysis.openInfoPanel('history');
	});
	el.refresh.addEventListener('click', function () {
		loadList();
	});
	el.retry.addEventListener('click', function () {
		loadList();
	});
	el.sort.addEventListener('change', function () {
		history.sort = el.sort.value;
		history.page = 1;
		history.confirmingId = null;
		loadList();
	});
	el.prev.addEventListener('click', function () {
		if (history.page > 1) {
			history.page--;
			history.confirmingId = null;
			loadList();
		}
	});
	el.next.addEventListener('click', function () {
		if (history.page < history.totalPages) {
			history.page++;
			history.confirmingId = null;
			loadList();
		}
	});
	document.addEventListener('gis:tabchange', function (event) {
		if (event.detail && event.detail.tab === 'history' && (history.stale || !history.loaded)) {
			loadList();
		}
	});
	document.addEventListener('gis:analysisresult', function (event) {
		onAnalysisResult(event.detail);
	});
	if (analysis.getCurrent) {
		onAnalysisResult(analysis.getCurrent());
	}

	window.gisHistory = {
		reload: function () {
			loadList();
		},
		getState: function () {
			return {
				saving: save.saving, saveFinished: save.finished, saveGeneration: save.generation,
				page: history.page, sort: history.sort, totalPages: history.totalPages, totalItems: history.totalItems,
				loaded: history.loaded, stale: history.stale, confirmingId: history.confirmingId,
				openingId: history.openingId, deletingId: history.deletingId
			};
		}
	};
})();
