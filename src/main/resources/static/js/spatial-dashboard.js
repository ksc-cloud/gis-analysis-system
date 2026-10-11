/*
 * GIS 3D 지도 - 공간 통계 대시보드 (8-6A, 정보 패널의 "공간 분석" 탭)
 *
 * - 'gis:analysisresult'(map-analysis.js)로 지금 화면의 분석을 알고, 공간 분석 탭이 보일 때만 통계를 요청한다.
 *     저장 전 분석(source 'live')  : GET /api/analysis-snapshots/{token}/statistics
 *     저장된 분석(source 'saved')  : GET /api/analyses/{id}/statistics
 * - 저장하면 서버가 스냅샷을 지우므로, 'gis:analysissaved'(map-history.js)를 받으면 진행 중인 스냅샷 요청을 취소하고
 *   저장된 분석 ID로 전환한다. 이전 토큰으로는 다시 요청하지 않는다.
 * - 요청은 AbortController + 요청 번호 + 분석 키(generation 포함)로 관리해 늦은 응답이 최신 화면을 덮어쓰지 않는다.
 *   같은 분석의 통계가 이미 요청 중이거나 표시 중이면 다시 요청하지 않는다.
 * - 분석 서버 상태(GET /api/spatial-analysis/status)는 페이지 로드 후 한 번, 탭을 열 때 마지막 확인 후 30초가 지났으면
 *   다시 확인한다. 주기적으로 확인하지 않는다. 사용할 수 없으면 통계만 안내하고 다른 기능에는 영향을 주지 않는다.
 * - 오류가 나도 지도와 반경 분석 결과는 건드리지 않는다. 외부 문자열은 textContent로만 넣는다.
 * - 상태 관리(createController)와 화면 값 계산(buildView, kpis)은 DOM 없이 동작해 node --test로 검사한다.
 * - 공간 분석 탭에는 통계·격자·비교 보기가 있다(보기 전환: spatial-compare.js, 'gis:spatialviewchange').
 *   통계는 통계 보기가 보일 때만 요청한다. 분석 서버 상태가 바뀌면 'gis:spatialstatus' { state }를 보낸다.
 */
(function (factory) {
	'use strict';
	var dashboard = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = dashboard;
	} else {
		dashboard.start(document, window);
	}
})(function () {
	'use strict';

	var STATUS_MAX_AGE_MS = 30000;

	var MISSING_LABELS = { 'null': '정보 없음', zero: '0층', invalid: '비정상 값' };

	var EXCLUDED_LABELS = { INVALID_GEOMETRY: '도형 오류', ZERO_AREA: '면적 없음', OUTSIDE_RADIUS: '반경 밖' };

	/* ---------- 화면 값 (순수 함수) ---------- */

	function isObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	function text(value) {
		return value == null ? '' : String(value);
	}

	/*
	 * Java 응답 { result: building-stats } → 대시보드 값. 필수 구조가 없으면 null.
	 * building-stats 필드: counts, footprint, withinRadius, floors, completeness, warnings, excluded
	 */
	function buildView(body) {
		var r = isObject(body) ? body.result : null;
		if (!isObject(r) || !isObject(r.counts) || !isObject(r.footprint) || !isObject(r.withinRadius)
				|| !isObject(r.floors) || !isObject(r.completeness)) {
			return null;
		}
		var excludedByReason = {};
		(Array.isArray(r.excluded) ? r.excluded : []).forEach(function (item) {
			var reason = isObject(item) ? text(item.reason) : '';
			excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
		});
		return {
			radiusMeters: r.radiusMeters,
			total: r.counts.total,
			analyzed: r.counts.analyzed,
			excluded: r.counts.excluded,
			excludedByReason: excludedByReason,
			unionArea: r.withinRadius.unionArea,
			coveragePercent: r.withinRadius.coveragePercent,
			averageArea: r.footprint.averageArea,
			averageFloors: r.floors.average,
			floorsWithData: r.floors.withData,
			floorsMissing: r.floors.withoutData,
			missingBreakdown: isObject(r.floors.missingBreakdown) ? r.floors.missingBreakdown : {},
			complete: r.completeness.complete === true,
			reasons: (Array.isArray(r.completeness.reasons) ? r.completeness.reasons : []).filter(isObject)
				.map(function (reason) {
					return { code: text(reason.code), message: text(reason.message) };
				}),
			// 부분 조회 경고(PARTIAL_RESULT)는 완전성 안내 상자에서 따로 표시한다.
			warnings: (Array.isArray(r.warnings) ? r.warnings : []).filter(function (w) {
				return isObject(w) && w.code !== 'PARTIAL_RESULT';
			}).map(function (w) {
				return { code: text(w.code), message: text(w.message), count: typeof w.count === 'number' ? w.count : null };
			})
		};
	}

	function breakdownText(breakdown, labels) {
		return Object.keys(labels).filter(function (key) {
			return breakdown[key] > 0;
		}).map(function (key) {
			return labels[key] + ' ' + breakdown[key];
		}).join(' · ');
	}

	/* KPI 카드: [{ key, label, value, note }] (값은 표시용 문자열) */
	function kpis(view, api) {
		var floorsNote = view.floorsWithData > 0 ? '층수 정보가 있는 ' + api.formatCount(view.floorsWithData) + ' 기준' : '';
		var missingNote = breakdownText(view.missingBreakdown, MISSING_LABELS);
		var excludedNote = breakdownText(view.excludedByReason, EXCLUDED_LABELS);
		return [
			{ key: 'radius', label: '분석 반경', value: api.formatRadius(view.radiusMeters), note: '' },
			{ key: 'buildings', label: '분석 건물 수', value: api.formatCount(view.analyzed),
				note: '입력 ' + api.formatCount(view.total) },
			{ key: 'area', label: '건물 점유 면적', value: api.formatArea(view.unionArea), note: '겹친 면적은 한 번만 계산' },
			{ key: 'coverage', label: '건물 점유율', value: api.formatPercent(view.coveragePercent),
				note: view.complete ? '반경 원 면적 대비' : '관측된 건물 기준' },
			{ key: 'averageArea', label: '평균 건물 면적', value: api.formatArea(view.averageArea), note: '건물 전체 면적 기준' },
			{ key: 'averageFloors', label: '평균 층수', value: api.formatFloors(view.averageFloors), note: floorsNote },
			{ key: 'floorsMissing', label: '층수 정보 없는 건물', value: api.formatCount(view.floorsMissing),
				note: missingNote },
			{ key: 'excluded', label: '제외된 건물', value: api.formatCount(view.excluded), note: excludedNote }
		];
	}

	/* ---------- 상태 관리 (DOM 없음) ---------- */

	function analysisKey(target) {
		if (!target) {
			return null;
		}
		return target.generation + ':' + (target.kind === 'saved' ? 'id:' + target.analysisId : 'token:' + target.token);
	}

	/*
	 * deps: {
	 *   api: gisSpatialApi, base: '/api' (컨텍스트 경로 포함), fetchJson(url, signal) → Promise,
	 *   now() → ms, online() → boolean, render(state), statusMaxAgeMs?
	 * }
	 * stats.phase: empty(분석 없음) | idle(아직 요청 안 함) | waiting(서버 상태 확인 대기) | blocked(서버 사용 불가)
	 *              | loading | done | error
	 */
	function createController(deps) {
		var api = deps.api;
		var maxAge = deps.statusMaxAgeMs == null ? STATUS_MAX_AGE_MS : deps.statusMaxAgeMs;
		var state = {
			visible: false,
			target: null,
			service: { state: 'checking', checkedAt: null },
			stats: { key: null, phase: 'empty', view: null, error: null },
			requestCount: 0
		};
		var seq = 0;
		var controller = null;
		var statusSeq = 0;
		var statusPromise = null;

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

		function resetStats(key) {
			abort();
			state.stats = { key: key, phase: key ? 'idle' : 'empty', view: null, error: null };
		}

		/* gis:analysisresult detail (map-analysis.js getCurrent()) */
		function setAnalysis(detail) {
			var source = detail && detail.source;
			var target = null;
			if (source === 'saved' && detail.analysisId != null) {
				target = { generation: detail.generation, kind: 'saved', analysisId: detail.analysisId, token: null,
					title: detail.title, radius: detail.radius, expiresAt: null };
			} else if (source === 'live') {
				target = { generation: detail.generation, kind: 'snapshot', analysisId: null,
					token: detail.analysisToken || null, title: null, radius: detail.radius,
					expiresAt: detail.snapshotExpiresAt || null };
			}
			var key = analysisKey(target);
			state.target = target;
			if (key !== state.stats.key) {
				resetStats(key);
			}
			render();
			load();
		}

		/* gis:analysissaved detail { generation, analysisId, title } (map-history.js) */
		function analysisSaved(detail) {
			var target = state.target;
			if (!detail || !target || target.kind !== 'snapshot' || target.generation !== detail.generation
					|| detail.analysisId == null) {
				return;
			}
			state.target = { generation: target.generation, kind: 'saved', analysisId: detail.analysisId, token: null,
				title: detail.title || null, radius: target.radius, expiresAt: null };
			var key = analysisKey(state.target);
			if (state.stats.phase === 'done') {
				// 같은 분석의 통계이므로 다시 계산하지 않고, 이후 요청만 저장된 분석 ID로 한다.
				state.stats.key = key;
			} else {
				resetStats(key);
			}
			render();
			load();
		}

		function show() {
			state.visible = true;
			render();
			refreshStatus(false);
			load();
		}

		function hide() {
			state.visible = false;
		}

		/* force: 마지막 확인 시각과 관계없이 확인 ("다시 확인" 버튼, 서버 사용 불가 오류 후) */
		function refreshStatus(force) {
			if (statusPromise) {
				return statusPromise;
			}
			var checkedAt = state.service.checkedAt;
			if (!force && checkedAt != null && deps.now() - checkedAt < maxAge) {
				return Promise.resolve(state.service.state);
			}
			var mySeq = ++statusSeq;
			state.service = { state: 'checking', checkedAt: checkedAt };
			if (state.stats.phase === 'blocked') {
				state.stats.phase = 'waiting';
			}
			render();
			statusPromise = deps.fetchJson(api.statusUrl(deps.base), undefined).then(function (res) {
				if (mySeq !== statusSeq) {
					return state.service.state;
				}
				statusPromise = null;
				state.service = { state: api.serviceState(res), checkedAt: deps.now() };
				var stats = state.stats;
				if (stats.phase === 'waiting' || (stats.phase === 'error' && stats.error && stats.error.serviceDown
						&& state.service.state === 'available')) {
					// 서버가 다시 사용 가능해졌으면 연결 실패로 끝난 통계도 다시 요청한다.
					stats.phase = 'idle';
					stats.error = null;
				}
				render();
				load();
				return state.service.state;
			});
			return statusPromise;
		}

		function load() {
			var stats = state.stats;
			var target = state.target;
			if (!state.visible || !target || stats.phase === 'loading' || stats.phase === 'done'
					|| stats.phase === 'error') {
				return; // 숨김, 분석 없음, 이미 요청 중/표시 중(중복 방지), 오류("다시 시도"로만 재요청)
			}
			var service = state.service.state;
			if (service === 'checking') {
				stats.phase = 'waiting';
				render();
				return;
			}
			if (service === 'unavailable' || service === 'not-configured') {
				stats.phase = 'blocked';
				render();
				return;
			}
			var url = api.statisticsUrl(target, deps.base);
			if (!url) {
				stats.phase = 'error';
				stats.error = api.describeError({ status: 400, body: { error: 'INVALID_TOKEN' } });
				render();
				return;
			}
			abort();
			var mySeq = seq;
			var key = stats.key;
			controller = typeof AbortController === 'function' ? new AbortController() : null;
			stats.phase = 'loading';
			stats.error = null;
			state.requestCount++;
			render();
			deps.fetchJson(url, controller ? controller.signal : undefined).then(function (res) {
				if (mySeq !== seq || key !== state.stats.key) {
					return; // 새 분석, 저장 전환, 초기화로 대체된 응답
				}
				controller = null;
				if (res && res.aborted) {
					return;
				}
				var view = res && res.ok ? buildView(res.body) : null;
				if (view) {
					state.stats.phase = 'done';
					state.stats.view = view;
				} else {
					var error = res && res.ok
						? api.describeError({ ok: false, status: 502, body: { error: 'ANALYSIS_SERVICE_BAD_RESPONSE' } })
						: api.describeError(res, deps.online ? deps.online() : true);
					state.stats.phase = 'error';
					state.stats.error = error;
					if (error.serviceDown) {
						refreshStatus(true);
					}
				}
				render();
			});
		}

		/* "다시 시도": 오류가 난 통계만 다시 요청한다. */
		function retry() {
			if (state.stats.phase !== 'error') {
				return;
			}
			state.stats.phase = 'idle';
			state.stats.error = null;
			load();
		}

		return {
			setAnalysis: setAnalysis,
			analysisSaved: analysisSaved,
			show: show,
			hide: hide,
			refreshStatus: refreshStatus,
			retry: retry,
			getState: function () {
				return state;
			}
		};
	}

	/* ---------- 화면 (브라우저) ---------- */

	function start(doc, win) {
		var api = win.gisSpatialApi;
		var script = doc.currentScript;
		var el = {
			section: doc.getElementById('spatial-section'),
			serviceBox: doc.getElementById('spatial-service'),
			serviceBadge: doc.getElementById('spatial-service-badge'),
			serviceText: doc.getElementById('spatial-service-text'),
			recheck: doc.getElementById('spatial-service-recheck'),
			empty: doc.getElementById('spatial-empty'),
			status: doc.getElementById('spatial-status'),
			retry: doc.getElementById('spatial-retry'),
			result: doc.getElementById('spatial-result'),
			source: doc.getElementById('spatial-source'),
			completeness: doc.getElementById('spatial-completeness'),
			kpis: doc.getElementById('spatial-kpis'),
			warningsTitle: doc.getElementById('spatial-warnings-title'),
			warnings: doc.getElementById('spatial-warnings')
		};
		if (!api || !el.section || !el.kpis || !el.status) {
			return;
		}
		var analysis = win.gisAnalysis;
		var base = (script && script.getAttribute('data-api-base')) || '/api';
		var rendered = { viewKey: null, serviceState: null };
		var visibility = { tab: !el.section.hidden, view: 'stats' };

		function show(node, visible) {
			if (node) {
				node.hidden = !visible;
			}
		}

		function formatDateTime(iso) {
			return analysis && analysis.formatDateTime ? analysis.formatDateTime(iso) : text(iso);
		}

		function sourceText(target) {
			if (target.kind === 'saved') {
				return '저장된 분석 #' + target.analysisId + (target.title ? ' · ' + target.title : '');
			}
			return '저장 전 분석 · 반경 ' + api.formatRadius(target.radius)
				+ (target.expiresAt ? ' · ' + formatDateTime(target.expiresAt) + '까지 조회 가능' : '');
		}

		function renderService(service) {
			if (rendered.serviceState !== service.state) {
				rendered.serviceState = service.state;
				doc.dispatchEvent(new win.CustomEvent('gis:spatialstatus', { detail: { state: service.state } }));
			}
			el.serviceBox.setAttribute('data-state', service.state);
			el.serviceBadge.textContent = api.SERVICE_LABELS[service.state] || service.state;
			el.serviceText.textContent = api.SERVICE_TEXTS[service.state] || '';
			el.recheck.disabled = service.state === 'checking';
		}

		function renderCompleteness(view) {
			el.completeness.textContent = '';
			el.completeness.className = 'analysis__completeness' + (view.complete ? '' : ' is-incomplete');
			var title = doc.createElement('p');
			title.className = 'analysis__completeness-title';
			title.textContent = view.complete ? '완전한 결과' : '부분 조회 결과 · 관측된 건물만 집계한 결과입니다';
			el.completeness.appendChild(title);
			var body = doc.createElement('p');
			body.className = 'spatial__completeness-text';
			body.textContent = view.complete
				? 'VWorld가 반경 안에서 보고한 건물을 모두 집계했습니다.'
				: '조회되지 않은 건물이 있으므로 건물 수, 면적, 점유율은 실제 지역 전체보다 작을 수 있습니다. '
					+ '지역 전체의 값으로 표시하지 마세요.';
			el.completeness.appendChild(body);
			if (view.reasons.length) {
				var list = doc.createElement('ul');
				view.reasons.forEach(function (reason) {
					var item = doc.createElement('li');
					item.textContent = reason.message || reason.code;
					list.appendChild(item);
				});
				el.completeness.appendChild(list);
			}
		}

		function renderKpis(view) {
			el.kpis.textContent = '';
			kpis(view, api).forEach(function (kpi) {
				var card = doc.createElement('div');
				card.className = 'spatial-kpi';
				card.setAttribute('data-kpi', kpi.key);
				var label = doc.createElement('span');
				label.className = 'spatial-kpi__label';
				label.textContent = kpi.label;
				var value = doc.createElement('strong');
				value.className = 'spatial-kpi__value';
				value.textContent = kpi.value;
				card.appendChild(label);
				card.appendChild(value);
				if (kpi.note) {
					var note = doc.createElement('span');
					note.className = 'spatial-kpi__note';
					note.textContent = kpi.note;
					card.appendChild(note);
				}
				el.kpis.appendChild(card);
			});
		}

		function renderWarnings(view) {
			el.warnings.textContent = '';
			view.warnings.forEach(function (warning) {
				var item = doc.createElement('li');
				item.textContent = (warning.message || warning.code)
					+ (warning.count != null ? ' (' + api.formatCount(warning.count, '건') + ')' : '');
				el.warnings.appendChild(item);
			});
			show(el.warningsTitle, view.warnings.length > 0);
			show(el.warnings, view.warnings.length > 0);
		}

		function statusText(state) {
			var stats = state.stats;
			switch (stats.phase) {
			case 'waiting':
				return '공간 분석 서버 상태를 확인한 뒤 통계를 계산합니다...';
			case 'loading':
				return '공간 통계를 계산하고 있습니다...';
			case 'blocked':
				return '공간 분석 서버를 사용할 수 없어 공간 통계를 계산하지 않았습니다. 서버가 준비되면 "다시 확인"을 누르세요.';
			case 'error':
				return stats.error ? stats.error.message : '';
			default:
				return '';
			}
		}

		function render(state) {
			var stats = state.stats;
			var target = state.target;
			renderService(state.service);
			el.section.setAttribute('data-state', stats.phase);
			el.section.setAttribute('aria-busy', String(stats.phase === 'loading'));
			show(el.empty, !target);
			var message = statusText(state);
			el.status.textContent = message;
			el.status.className = 'spatial__status' + (stats.phase === 'error' ? ' is-error' : '');
			show(el.status, !!message);
			show(el.retry, stats.phase === 'error' && !!stats.error && stats.error.retryable);
			var done = stats.phase === 'done' && !!stats.view && !!target;
			show(el.result, done);
			if (!done) {
				rendered.viewKey = null;
				return;
			}
			el.source.textContent = sourceText(target);
			if (rendered.viewKey !== stats.view) {
				// 통계 값이 바뀔 때만 다시 그린다. (저장 전환·상태 확인 때는 출처 문구만 바뀐다)
				rendered.viewKey = stats.view;
				renderCompleteness(stats.view);
				renderKpis(stats.view);
				renderWarnings(stats.view);
			}
		}

		var controller = createController({
			api: api,
			base: base,
			fetchJson: function (url, signal) {
				return api.getJson(url, signal);
			},
			now: function () {
				return Date.now();
			},
			online: function () {
				return win.navigator.onLine !== false;
			},
			render: render
		});

		el.recheck.addEventListener('click', function () {
			controller.refreshStatus(true);
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
		// 공간 분석 탭이 열려 있고 통계 보기일 때만 통계를 요청한다. 탭을 열면 보기와 관계없이 서버 상태를 확인한다.
		function syncVisibility() {
			if (visibility.tab && visibility.view === 'stats') {
				controller.show();
			} else {
				controller.hide();
				if (visibility.tab) {
					controller.refreshStatus(false);
				}
			}
		}
		doc.addEventListener('gis:tabchange', function (event) {
			visibility.tab = !!(event.detail && event.detail.tab === 'spatial');
			syncVisibility();
		});
		doc.addEventListener('gis:spatialviewchange', function (event) {
			visibility.view = event.detail && event.detail.view ? event.detail.view : 'stats';
			syncVisibility();
		});

		if (analysis && analysis.getCurrent) {
			controller.setAnalysis(analysis.getCurrent());
		}
		if (visibility.tab) {
			syncVisibility();
		} else {
			controller.refreshStatus(true); // 페이지 로드 후 한 번 확인한다.
		}

		win.gisSpatialDashboard = {
			getState: controller.getState,
			refreshStatus: function () {
				return controller.refreshStatus(true);
			}
		};
	}

	return {
		STATUS_MAX_AGE_MS: STATUS_MAX_AGE_MS,
		buildView: buildView,
		kpis: kpis,
		analysisKey: analysisKey,
		createController: createController,
		start: start
	};
});
