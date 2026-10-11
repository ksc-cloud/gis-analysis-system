/*
 * GIS 3D 지도 - 저장된 분석 비교 (8-6C, 정보 패널 "공간 분석" 탭의 "비교" 보기)
 *
 * - 분석 이력(map-history.js)의 "비교 선택"으로 저장된 분석을 최대 2건 고른다. 선택 상태는 이 파일이 가지며
 *   (window.gisCompare), 페이지를 넘겨도 유지된다. 바뀔 때마다 'gis:compareselection'을 보낸다.
 *   이력이 삭제되면('gis:historychange' { deletedId }) 선택과 그 분석의 비교 결과에서 지운다.
 * - 비교: GET /api/analyses/{id}/comparison?with={otherId} (Java가 Python 결과를 전달한다. 이전·이후는 분석 시각 순)
 *   요청은 AbortController + 요청 번호 + 비교 키로 관리해 늦은 응답이 최신 화면을 덮어쓰지 않고, 같은 비교가
 *   요청 중이거나 표시 중이면 다시 요청하지 않는다. 선택이 바뀌어 비교 대상이 달라지면 이전 결과를 지운다.
 * - 분석 서버 상태는 spatial-dashboard.js가 확인한다('gis:spatialstatus'). 사용할 수 없으면 비교만 막는다.
 * - comparisonBasis가 OBSERVATION_DIFFERENCE이면 부분 조회 경고를 맨 위에 둔다. 추가·삭제는 데이터에 나타나거나
 *   사라진 것이며 신축·철거로 표현하지 않는다. 점유율의 변화는 %p로 표시한다.
 * - 외부 문자열(제목, 건물 ID, 서버 메시지)은 textContent로만 넣는다.
 * - 선택, 화면 값, 상태 관리는 DOM 없이 동작해 node --test로 검사한다.
 */
(function (factory) {
	'use strict';
	var compare = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = compare;
	} else {
		compare.start(document, window);
	}
})(function () {
	'use strict';

	var MAX_SELECTION = 2;
	var PAGE_SIZE = 50;

	var BASES = ['CHANGE', 'OBSERVATION_DIFFERENCE'];

	var STATUS_LABELS = {
		ADDED: '추가 (데이터 기준)',
		REMOVED: '삭제 (데이터 기준)',
		ONLY_IN_AFTER: '이후 분석에서만 관측',
		ONLY_IN_BEFORE: '이전 분석에서만 관측',
		MODIFIED: '변경',
		UNCHANGED: '변경 없음'
	};

	var CHANGE_LABELS = { GEOMETRY: '도형 변경', FLOORS: '층수 변경', FLOORS_DATA: '층수 정보 변경', RELATION: '경계 관계 변경' };

	var CONFIDENCE_LABELS = { HIGH: '높음', MEDIUM: '보통', LOW: '낮음' };

	var MATCH_BASIS_LABELS = {
		BD_MGT_SN: '건물관리번호 일치',
		FEATURE_ID_AND_IOU: 'VWorld 객체 ID 일치 + 도형 IoU 0.5 이상'
	};

	var SIDE_LABELS = { BEFORE: '이전', AFTER: '이후', BOTH: '양쪽' };

	var UNCOMPARABLE_LABELS = {
		ROW_IDENTIFIER: '임시 식별자(row:)라 같은 건물인지 알 수 없음',
		UNKNOWN_IDENTIFIER: '알 수 없는 형식의 식별자',
		FEATURE_ID_UNVERIFIED: 'VWorld 객체 ID는 같지만 도형이 달라(IoU 0.5 미만) 같은 건물로 보지 않음',
		GEOMETRY_EXCLUDED: '도형을 읽을 수 없어 분석에서 제외됨',
		OUTSIDE_RADIUS: '반경 밖으로 판정되어 분석에서 제외됨',
		COUNTERPART_EXCLUDED: '다른 분석에서 이 건물의 도형이 제외되어 비교하지 않음',
		GEOMETRY_REPAIRED: '유효하지 않은 도형을 복구해 비교함'
	};

	var NOT_COMPARABLE_LABELS = {
		CENTER_DIFFERENT: '두 분석의 중심점이 다릅니다. (허용 오차 0.05m)',
		RADIUS_DIFFERENT: '두 분석의 반경이 다릅니다.',
		CRITERION_DIFFERENT: '두 분석의 건물 포함 기준이 다릅니다.',
		CRITERION_UNSUPPORTED: '비교할 수 없는 건물 포함 기준입니다.',
		DATA_SOURCE_DIFFERENT: '두 분석의 데이터 출처가 다릅니다.',
		COORDINATE_SYSTEM_DIFFERENT: '두 분석의 좌표계가 다릅니다.'
	};

	var CANDIDATE_LABELS = { CANDIDATE: '후보', AMBIGUOUS: '후보 여러 개 (대응 불명확)' };

	var VWORLD_NOTE = '변화는 두 분석 시점에 VWorld 도로명주소 건물 데이터가 달랐다는 뜻입니다. VWorld 데이터 갱신 시점은 '
		+ '실제 건물의 신축·철거·증축 시점과 다를 수 있습니다.';

	/* ---------- 선택 (순수) ---------- */

	function isValidId(id) {
		return typeof id === 'number' && isFinite(id) && id >= 1 && Math.floor(id) === id;
	}

	function text(value) {
		return value == null ? '' : String(value);
	}

	function isObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	/* ---------- 화면 값 (순수) ---------- */

	function direction(value) {
		if (typeof value !== 'number' || !isFinite(value)) {
			return 'none';
		}
		return value > 0 ? 'up' : (value < 0 ? 'down' : 'zero');
	}

	function formatValue(kind, value, api) {
		switch (kind) {
		case 'count':
			return api.formatCount(value);
		case 'area':
			return api.formatArea(value);
		case 'floors':
			return api.formatFloors(value);
		case 'coverage':
			return typeof value === 'number' && isFinite(value) ? api.formatPercent(value * 100) : '-';
		default:
			return api.formatNumber(value, 1);
		}
	}

	function formatDelta(kind, value, api) {
		if (typeof value !== 'number' || !isFinite(value)) {
			return '-';
		}
		var magnitude = Math.abs(value);
		switch (kind) {
		case 'count':
			return api.signed(value, api.formatCount(magnitude));
		case 'area':
			return api.signed(value, api.formatArea(magnitude));
		case 'floors':
			return api.signed(value, api.formatNumber(magnitude, 1) + '층');
		default:
			return api.signed(value, api.formatNumber(magnitude, 1));
		}
	}

	// changeRate(비율) → "+10.4%", null이면 "계산 불가" (이전 값이 0이거나 값이 없음)
	function formatRate(rate, api) {
		if (typeof rate !== 'number' || !isFinite(rate)) {
			return '계산 불가';
		}
		return api.signed(rate, api.formatNumber(Math.abs(rate) * 100, 1)) + '%';
	}

	var METRICS = [
		{ key: 'buildingCount', label: '건물 수', kind: 'count' },
		{ key: 'unionArea', label: '건물 점유 면적', kind: 'area' },
		{ key: 'coverageRatio', label: '건물 점유율', kind: 'coverage' },
		{ key: 'averageArea', label: '평균 건물 면적', kind: 'area' },
		{ key: 'averageFloors', label: '평균 층수', kind: 'floors' },
		{ key: 'floorsWithData', label: '층수 정보가 있는 건물 수', kind: 'count' }
	];

	/* statistics → [{ key, label, before, after, delta, rate, direction }] (표시용 문자열) */
	function metricRows(statistics, api) {
		return METRICS.map(function (metric) {
			var m = isObject(statistics) && isObject(statistics[metric.key]) ? statistics[metric.key] : {};
			var coverage = metric.kind === 'coverage';
			var change = coverage ? m.deltaPercentPoint : m.delta;
			return {
				key: metric.key,
				label: metric.label,
				before: formatValue(metric.kind, m.before, api),
				after: formatValue(metric.kind, m.after, api),
				// 점유율 변화는 퍼센트포인트(%p), 나머지는 단위 그대로
				delta: coverage ? api.formatPercentPoint(change) : formatDelta(metric.kind, change, api),
				rate: formatRate(m.changeRate, api),
				direction: direction(change)
			};
		});
	}

	function statusLabel(status) {
		return STATUS_LABELS[status] || text(status);
	}

	function floorsText(value, api) {
		return typeof value === 'number' && isFinite(value) ? api.formatNumber(value, 0) + '층' : '정보 없음';
	}

	/* buildings.changes[] 한 건 → 표시용 값 */
	function changeItem(change, api) {
		var c = isObject(change) ? change : {};
		var side = c.after || c.before;
		var area;
		if (isObject(c.footprintArea)) {
			area = api.formatArea(c.footprintArea.before) + ' → ' + api.formatArea(c.footprintArea.after)
				+ ' (' + formatDelta('area', c.footprintArea.delta, api) + ', ' + formatRate(c.footprintArea.changeRate, api) + ')';
		} else {
			area = isObject(side) ? api.formatArea(side.footprintArea) + (c.after ? ' (이후 분석)' : ' (이전 분석)') : '-';
		}
		var floors;
		if (isObject(c.floors)) {
			floors = floorsText(c.floors.before, api) + ' → ' + floorsText(c.floors.after, api)
				+ (typeof c.floors.delta === 'number' ? ' (' + api.signed(c.floors.delta, api.formatNumber(Math.abs(c.floors.delta), 0)) + '층)' : '');
		} else {
			floors = isObject(side) ? floorsText(side.floors, api) : '-';
		}
		var match = isObject(c.match) ? c.match : null;
		return {
			id: text(c.id),
			status: text(c.status),
			statusLabel: statusLabel(c.status),
			area: area,
			floors: floors,
			iou: typeof c.iou === 'number' && isFinite(c.iou) ? api.formatNumber(c.iou, 3) : '-',
			confidence: match ? (CONFIDENCE_LABELS[match.confidence] || text(match.confidence)) : '-',
			basis: match ? (MATCH_BASIS_LABELS[match.basis] || text(match.basis)) : '식별자가 한쪽 분석에만 있음',
			changes: (Array.isArray(c.changes) ? c.changes : []).map(function (code) {
				return CHANGE_LABELS[code] || text(code);
			})
		};
	}

	function uncomparableItem(item, api) {
		var u = isObject(item) ? item : {};
		return {
			id: text(u.id),
			side: SIDE_LABELS[u.side] || text(u.side),
			category: u.category === 'LOW_CONFIDENCE' ? '신뢰도 낮음' : '비교 불가',
			reason: UNCOMPARABLE_LABELS[u.reason] || text(u.reason),
			iou: typeof u.iou === 'number' && isFinite(u.iou) ? api.formatNumber(u.iou, 3) : null
		};
	}

	function candidateItem(item, api) {
		var c = isObject(item) ? item : {};
		return {
			beforeId: text(c.beforeId),
			afterId: text(c.afterId),
			iou: typeof c.iou === 'number' && isFinite(c.iou) ? api.formatNumber(c.iou, 3) : '-',
			status: CANDIDATE_LABELS[c.status] || text(c.status)
		};
	}

	/* buildings.summary → [{ key, label, value }] (부분 조회이면 "~에서만 관측"으로 표시) */
	function summaryItems(summary, basis, api) {
		var s = isObject(summary) ? summary : {};
		var observed = basis === 'OBSERVATION_DIFFERENCE';
		var count = function (value) {
			return api.formatCount(typeof value === 'number' ? value : 0, '건');
		};
		return [
			observed ? { key: 'onlyInAfter', label: STATUS_LABELS.ONLY_IN_AFTER, value: count(s.onlyInAfter) }
				: { key: 'added', label: STATUS_LABELS.ADDED, value: count(s.added) },
			observed ? { key: 'onlyInBefore', label: STATUS_LABELS.ONLY_IN_BEFORE, value: count(s.onlyInBefore) }
				: { key: 'removed', label: STATUS_LABELS.REMOVED, value: count(s.removed) },
			{ key: 'modified', label: '변경', value: count(s.modified) },
			{ key: 'unchanged', label: '변경 없음', value: count(s.unchanged) },
			{ key: 'uncomparable', label: '비교 불가',
				value: '이전 ' + count(s.uncomparableBefore) + ' · 이후 ' + count(s.uncomparableAfter) },
			{ key: 'lowConfidence', label: '신뢰도 낮음', value: count(s.lowConfidence) },
			{ key: 'candidates', label: 'ID 변경 가능성',
				value: count(s.candidates) + (s.ambiguousCandidates ? ' (불명확 ' + count(s.ambiguousCandidates) + ')' : '') }
		];
	}

	function sideView(side, id, selection) {
		var s = isObject(side) ? side : {};
		var source = isObject(s.source) ? s.source : {};
		var analysisId = isValidId(id) ? id : source.analysisId;
		var picked = (selection || []).filter(function (item) {
			return item.analysisId === analysisId;
		})[0];
		return {
			analysisId: analysisId,
			title: picked && picked.title ? picked.title : '분석 #' + analysisId,
			analyzedAt: text(source.analyzedAt),
			radiusMeters: s.radiusMeters,
			complete: s.complete === true,
			analyzed: isObject(s.counts) ? s.counts.analyzed : null
		};
	}

	/*
	 * Java 응답 { analysisIds: [이전, 이후], result: compare-analyses 응답 } → 비교 화면 값. 구조가 다르면 null.
	 * selection: 비교 선택 항목(제목 표시용)
	 */
	function buildCompareView(body, selection) {
		var r = isObject(body) ? body.result : null;
		if (!isObject(r) || typeof r.comparable !== 'boolean' || BASES.indexOf(r.comparisonBasis) < 0
				|| !isObject(r.before) || !isObject(r.after)) {
			return null;
		}
		if (r.comparable && (!isObject(r.statistics) || !isObject(r.buildings) || !isObject(r.buildings.summary))) {
			return null;
		}
		var ids = Array.isArray(body.analysisIds) ? body.analysisIds : [];
		var buildings = isObject(r.buildings) ? r.buildings : {};
		var list = function (value) {
			return Array.isArray(value) ? value : [];
		};
		return {
			comparable: r.comparable,
			basis: r.comparisonBasis,
			before: sideView(r.before, ids[0], selection),
			after: sideView(r.after, ids[1], selection),
			reasons: list(r.notComparableReasons).filter(isObject).map(function (reason) {
				return { code: text(reason.code), label: NOT_COMPARABLE_LABELS[reason.code] || '비교 조건이 맞지 않습니다.',
					detail: text(reason.message) };
			}),
			statistics: r.statistics,
			summary: buildings.summary || null,
			changes: list(buildings.changes),
			uncomparable: list(buildings.uncomparable),
			candidates: list(buildings.possibleSameBuilding),
			warnings: list(r.warnings).filter(isObject).map(function (w) {
				return { code: text(w.code), message: text(w.message), count: typeof w.count === 'number' ? w.count : null };
			}).filter(function (w) {
				return w.code !== 'OBSERVATION_DIFFERENCE'; // 맨 위 경고 상자에서 따로 표시
			}),
			notes: list(r.notes).filter(isObject).map(function (note) {
				return text(note.message);
			}).filter(function (message) {
				return message.length > 0;
			})
		};
	}

	/* 맨 위 안내 상자: { warning, title, text } */
	function basisBox(view) {
		if (!view.comparable) {
			return { warning: true, title: '비교할 수 없는 분석입니다',
				text: '두 분석의 조건이 달라 직접 비교하지 않았습니다. 같은 중심점과 반경으로 분석해 저장한 이력을 고르세요.' };
		}
		if (view.basis === 'OBSERVATION_DIFFERENCE') {
			return { warning: true, title: '부분 조회 결과가 포함된 비교',
				text: '한쪽 이상의 분석이 부분 조회 결과입니다. 실제 건물의 신축이나 철거로 단정할 수 없습니다. '
					+ '차이는 관측된 건물의 차이이며, 한쪽에서만 관측된 건물은 조회 범위 차이일 수 있습니다.' };
		}
		return { warning: false, title: '두 분석 모두 완전한 결과',
			text: '추가·삭제는 VWorld 데이터에 건물이 나타나거나 사라졌다는 뜻이며 실제 신축·철거를 확인한 것이 아닙니다.' };
	}

	/* ---------- 상태 관리 (DOM 없음) ---------- */

	function compareKey(ids, includeUnchanged) {
		return ids.slice().sort(function (a, b) {
			return a - b;
		}).join(':') + ':' + (includeUnchanged ? 'all' : 'changed');
	}

	/*
	 * deps: { api, base, fetchJson(url, signal), online(), render(state), onSelectionChange(), refreshStatus() }
	 * request.phase: empty | loading | done | error | blocked(분석 서버 사용 불가)
	 * request.notice: null | 'selection-changed' | 'deleted' (결과를 지운 이유)
	 */
	function createController(deps) {
		var api = deps.api;
		var state = {
			selection: [],
			service: 'checking',
			includeUnchanged: false,
			request: { key: null, ids: null, phase: 'empty', view: null, error: null, notice: null },
			requestCount: 0
		};
		var seq = 0;
		var controller = null;

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

		function isSelected(id) {
			return state.selection.some(function (item) {
				return item.analysisId === id;
			});
		}

		function canSelect(id) {
			return isSelected(id) || state.selection.length < MAX_SELECTION;
		}

		function serviceBlocked() {
			return state.service === 'unavailable' || state.service === 'not-configured';
		}

		function canRun() {
			return state.selection.length === MAX_SELECTION && !serviceBlocked();
		}

		function clearRequest(notice) {
			abort();
			var had = state.request.phase !== 'empty';
			state.request = { key: null, ids: null, phase: 'empty', view: null, error: null, notice: had ? notice : null };
		}

		// 지금 결과(또는 요청 중인 비교)의 두 분석이 선택에 그대로 있지 않으면 결과를 지운다.
		function selectionChanged(notice) {
			var ids = state.request.ids;
			if (ids && !(isSelected(ids[0]) && isSelected(ids[1]))) {
				clearRequest(notice);
			}
			render();
			if (deps.onSelectionChange) {
				deps.onSelectionChange(state.selection.slice());
			}
		}

		/* item: 분석 이력 목록 항목 { analysisId, title, radiusMeters, complete, analyzedAt, ... } */
		function toggle(item) {
			var id = item && item.analysisId;
			if (!isValidId(id)) {
				return false;
			}
			if (isSelected(id)) {
				state.selection = state.selection.filter(function (selected) {
					return selected.analysisId !== id;
				});
			} else if (state.selection.length < MAX_SELECTION) {
				state.selection = state.selection.concat([{ analysisId: id, title: text(item.title),
					radiusMeters: item.radiusMeters, complete: item.complete === true, analyzedAt: item.analyzedAt || null }]);
			} else {
				return false;
			}
			selectionChanged('selection-changed');
			return true;
		}

		function clearSelection() {
			if (!state.selection.length) {
				return;
			}
			state.selection = [];
			selectionChanged('selection-changed');
		}

		/* 이력이 삭제됨: 선택과 그 분석이 들어간 비교 결과에서 지운다. */
		function removeDeleted(id) {
			var involved = !!(state.request.ids && state.request.ids.indexOf(id) >= 0);
			var selected = isSelected(id);
			if (!involved && !selected) {
				return;
			}
			state.selection = state.selection.filter(function (item) {
				return item.analysisId !== id;
			});
			if (involved) {
				clearRequest('deleted');
			}
			selectionChanged('deleted');
		}

		function setService(serviceState) {
			state.service = serviceState;
			if (state.request.phase === 'blocked' && !serviceBlocked() && serviceState !== 'checking') {
				state.request.phase = 'empty';
				run(); // 서버를 쓸 수 없어 미뤄 둔 비교를 이어서 한다.
				return;
			}
			render();
		}

		/* 선택한 두 건을 비교한다. 이미 같은 비교를 요청 중이거나 표시 중이면 아무것도 하지 않는다. */
		function run() {
			if (state.selection.length !== MAX_SELECTION) {
				return false;
			}
			var ids = state.selection.map(function (item) {
				return item.analysisId;
			});
			var key = compareKey(ids, state.includeUnchanged);
			var current = state.request;
			if (current.key === key && (current.phase === 'loading' || current.phase === 'done')) {
				return false;
			}
			if (serviceBlocked()) {
				abort();
				state.request = { key: key, ids: ids, phase: 'blocked', view: null, error: null, notice: null };
				render();
				return false;
			}
			var url = api.comparisonUrl(ids[0], ids[1], { includeUnchanged: state.includeUnchanged }, deps.base);
			abort();
			var mySeq = seq;
			controller = typeof AbortController === 'function' ? new AbortController() : null;
			state.request = { key: key, ids: ids, phase: 'loading', view: null, error: null, notice: null };
			state.requestCount++;
			render();
			deps.fetchJson(url, controller ? controller.signal : undefined).then(function (res) {
				if (mySeq !== seq || key !== state.request.key) {
					return; // 선택 변경, 삭제, 다른 비교로 대체된 응답
				}
				controller = null;
				if (res && res.aborted) {
					return;
				}
				var view = res && res.ok ? buildCompareView(res.body, state.selection) : null;
				if (view) {
					state.request.phase = 'done';
					state.request.view = view;
				} else {
					var error = res && res.ok
						? api.describeError({ ok: false, status: 502, body: { error: 'ANALYSIS_SERVICE_BAD_RESPONSE' } })
						: api.describeError(res, deps.online ? deps.online() : true);
					state.request.phase = 'error';
					state.request.error = error;
					if (error.serviceDown && deps.refreshStatus) {
						deps.refreshStatus();
					}
				}
				render();
			});
			return true;
		}

		/* "변경 없는 건물도 목록에 포함": 지금 비교가 있으면 그 옵션으로 다시 요청한다. */
		function setIncludeUnchanged(flag) {
			state.includeUnchanged = !!flag;
			var phase = state.request.phase;
			if (state.request.ids && (phase === 'done' || phase === 'error' || phase === 'loading')) {
				run();
				return;
			}
			render();
		}

		function retry() {
			if (state.request.phase !== 'error') {
				return;
			}
			state.request.key = null;
			run();
		}

		return {
			toggle: toggle,
			isSelected: isSelected,
			canSelect: canSelect,
			canRun: canRun,
			clearSelection: clearSelection,
			removeDeleted: removeDeleted,
			setService: setService,
			run: run,
			setIncludeUnchanged: setIncludeUnchanged,
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
		var $ = function (id) {
			return doc.getElementById(id);
		};
		var el = {
			historyBar: $('history-compare'),
			historyText: $('history-compare-text'),
			historyRun: $('history-compare-run'),
			historyClear: $('history-compare-clear'),
			viewCompare: $('spatial-view-compare'),
			empty: $('compare-empty'),
			selection: $('compare-selection'),
			run: $('compare-run'),
			openHistory: $('compare-open-history'),
			includeUnchanged: $('compare-include-unchanged'),
			status: $('compare-status'),
			retry: $('compare-retry'),
			result: $('compare-result'),
			pair: $('compare-pair'),
			basis: $('compare-basis'),
			reasons: $('compare-reasons'),
			metrics: $('compare-metrics'),
			summaryTitle: $('compare-summary-title'),
			summary: $('compare-summary'),
			lists: $('compare-lists'),
			warningsTitle: $('compare-warnings-title'),
			warnings: $('compare-warnings'),
			notes: $('compare-notes')
		};
		if (!api || !el.viewCompare || !el.result || !el.historyBar) {
			return;
		}
		var analysis = win.gisAnalysis;
		var base = (script && script.getAttribute('data-api-base')) || '/api';
		var rendered = { view: null };

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

		function formatDateTime(iso) {
			return analysis && analysis.formatDateTime ? analysis.formatDateTime(iso) : text(iso);
		}

		/* ---- 보기 전환은 spatial-views.js(window.gisSpatialViews)가 맡는다. 부를 때 찾으므로 로드 순서에 묶이지 않는다. ---- */

		function showView(name) {
			var views = win.gisSpatialViews;
			if (views && typeof views.show === 'function') {
				views.show(name);
			}
		}

		/* ---- 결과 그리기 ---- */

		function renderPair(view) {
			el.pair.textContent = '';
			[['이전 분석', view.before], ['이후 분석', view.after]].forEach(function (entry) {
				var side = entry[1];
				var card = make('div', 'compare-side');
				card.appendChild(make('span', 'compare-side__label', entry[0]));
				card.appendChild(make('strong', 'compare-side__title', side.title));
				card.appendChild(make('span', 'compare-side__meta', '#' + side.analysisId + ' · '
					+ formatDateTime(side.analyzedAt) + ' 분석 · 반경 ' + api.formatRadius(side.radiusMeters)
					+ ' · 건물 ' + api.formatCount(side.analyzed) + ' · ' + (side.complete ? '완전한 결과' : '부분 조회')));
				el.pair.appendChild(card);
			});
		}

		function renderBasis(view) {
			var box = basisBox(view);
			el.basis.textContent = '';
			el.basis.className = 'analysis__completeness' + (box.warning ? ' is-incomplete' : '');
			el.basis.setAttribute('data-basis', view.comparable ? view.basis : 'NOT_COMPARABLE');
			el.basis.appendChild(make('p', 'analysis__completeness-title', box.title));
			el.basis.appendChild(make('p', 'spatial__completeness-text', box.text));
			el.reasons.textContent = '';
			if (!view.comparable && view.reasons.length) {
				var list = make('ul', 'compare__reason-list');
				view.reasons.forEach(function (reason) {
					var item = make('li', null, reason.label);
					if (reason.detail) {
						item.appendChild(make('span', 'compare__reason-detail', ' ' + reason.detail));
					}
					list.appendChild(item);
				});
				el.reasons.appendChild(list);
			}
			show(el.reasons, !view.comparable && view.reasons.length > 0);
		}

		function renderMetrics(view) {
			el.metrics.textContent = '';
			if (!view.comparable) {
				return;
			}
			metricRows(view.statistics, api).forEach(function (row) {
				var card = make('div', 'compare-metric');
				card.setAttribute('data-metric', row.key);
				card.appendChild(make('span', 'compare-metric__label', row.label));
				card.appendChild(make('span', 'compare-metric__values', row.before + ' → ' + row.after));
				var delta = make('strong', 'compare-metric__delta compare-delta--' + row.direction, row.delta);
				card.appendChild(delta);
				card.appendChild(make('span', 'compare-metric__rate', '변화율 ' + row.rate));
				el.metrics.appendChild(card);
			});
		}

		function renderSummary(view) {
			el.summary.textContent = '';
			show(el.summaryTitle, view.comparable);
			if (!view.comparable) {
				return;
			}
			summaryItems(view.summary, view.basis, api).forEach(function (entry) {
				var chip = make('div', 'compare-summary__item');
				chip.setAttribute('data-summary', entry.key);
				chip.appendChild(make('span', 'compare-summary__label', entry.label));
				chip.appendChild(make('strong', 'compare-summary__value', entry.value));
				el.summary.appendChild(chip);
			});
		}

		// 접을 수 있는 목록. 처음에 50건, "더 보기"마다 50건씩 더 그린다.
		function pagedList(title, items, renderItem, emptyText) {
			var details = make('details', 'compare-list');
			details.open = true;
			details.appendChild(make('summary', 'compare-list__summary', title + ' (' + api.formatCount(items.length, '건') + ')'));
			if (!items.length) {
				details.appendChild(make('p', 'panel-hint', emptyText));
				return details;
			}
			var list = make('ol', 'compare-list__items');
			var more = make('button', 'building-status__retry compare-list__more');
			more.type = 'button';
			var shown = 0;
			function showMore() {
				items.slice(shown, shown + PAGE_SIZE).forEach(function (item) {
					list.appendChild(renderItem(item));
				});
				shown = Math.min(items.length, shown + PAGE_SIZE);
				more.textContent = '더 보기 (' + api.formatCount(items.length - shown, '건') + ' 남음)';
				more.hidden = shown >= items.length;
			}
			more.addEventListener('click', showMore);
			details.appendChild(list);
			details.appendChild(more);
			showMore();
			return details;
		}

		function changeNode(change) {
			var item = changeItem(change, api);
			var li = make('li', 'compare-item');
			li.setAttribute('data-status', item.status);
			var head = make('div', 'compare-item__head');
			head.appendChild(make('strong', 'compare-item__id', item.id));
			head.appendChild(make('span', 'compare-status compare-status--' + item.status.toLowerCase(), item.statusLabel));
			li.appendChild(head);
			li.appendChild(make('p', 'compare-item__row', '면적: ' + item.area));
			li.appendChild(make('p', 'compare-item__row', '층수: ' + item.floors));
			li.appendChild(make('p', 'compare-item__row', 'IoU ' + item.iou + ' · 신뢰도 ' + item.confidence
				+ ' · ' + item.basis));
			if (item.changes.length) {
				li.appendChild(make('p', 'compare-item__row', '변경 내용: ' + item.changes.join(', ')));
			}
			return li;
		}

		function uncomparableNode(entry) {
			var item = uncomparableItem(entry, api);
			var li = make('li', 'compare-item');
			var head = make('div', 'compare-item__head');
			head.appendChild(make('strong', 'compare-item__id', item.id));
			head.appendChild(make('span', 'compare-status compare-status--' + (item.category === '신뢰도 낮음' ? 'low' : 'uncomparable'),
				item.category));
			li.appendChild(head);
			li.appendChild(make('p', 'compare-item__row', item.side + ' 분석: ' + item.reason
				+ (item.iou != null ? ' (IoU ' + item.iou + ')' : '')));
			return li;
		}

		function candidateNode(entry) {
			var item = candidateItem(entry, api);
			var li = make('li', 'compare-item');
			li.appendChild(make('p', 'compare-item__row', item.beforeId + ' → ' + item.afterId));
			li.appendChild(make('p', 'compare-item__row', 'IoU ' + item.iou + ' · ' + item.status
				+ ' · 추가·삭제 판정에는 반영하지 않은 후보입니다.'));
			return li;
		}

		function renderLists(view) {
			el.lists.textContent = '';
			if (!view.comparable) {
				return;
			}
			el.lists.appendChild(pagedList('건물별 변경 목록', view.changes, changeNode,
				'표시할 변경 건물이 없습니다. "변경 없는 건물도 목록에 포함"을 켜면 변경 없는 건물도 볼 수 있습니다.'));
			el.lists.appendChild(pagedList('비교 불가·신뢰도 낮은 건물', view.uncomparable, uncomparableNode,
				'비교할 수 없거나 신뢰도가 낮은 건물이 없습니다.'));
			el.lists.appendChild(pagedList('ID 변경 가능성이 있는 건물', view.candidates, candidateNode,
				'식별자가 바뀐 것으로 보이는 건물이 없습니다.'));
		}

		function renderNotes(view) {
			el.warnings.textContent = '';
			view.warnings.forEach(function (warning) {
				el.warnings.appendChild(make('li', null, (warning.message || warning.code)
					+ (warning.count != null ? ' (' + api.formatCount(warning.count, '건') + ')' : '')));
			});
			show(el.warningsTitle, view.warnings.length > 0);
			show(el.warnings, view.warnings.length > 0);
			el.notes.textContent = '';
			el.notes.appendChild(make('li', null, VWORLD_NOTE));
			view.notes.forEach(function (note) {
				el.notes.appendChild(make('li', null, note));
			});
		}

		/* ---- 상태 그리기 ---- */

		function selectionText(selection) {
			return selection.map(function (item) {
				return item.title || ('분석 #' + item.analysisId);
			}).join(' ↔ ');
		}

		function statusText(state) {
			var request = state.request;
			if (request.phase === 'loading') {
				return '두 분석을 비교하고 있습니다...';
			}
			if (request.phase === 'blocked') {
				return '공간 분석 서버를 사용할 수 없어 비교할 수 없습니다. 지도, 반경 분석과 분석 이력은 계속 사용할 수 있습니다. '
					+ '"통계" 보기의 "다시 확인"으로 서버 상태를 확인하세요.';
			}
			if (request.phase === 'error') {
				return request.error ? request.error.message : '';
			}
			if (request.notice === 'deleted') {
				return '비교하던 분석 이력이 삭제되어 비교 결과를 지웠습니다.';
			}
			if (request.notice === 'selection-changed') {
				return '비교 선택이 바뀌어 이전 비교 결과를 지웠습니다.';
			}
			return '';
		}

		function renderHistoryBar(state) {
			var count = state.selection.length;
			show(el.historyBar, count > 0);
			var message = '비교 선택 ' + count + '/' + MAX_SELECTION + ': ' + selectionText(state.selection);
			if (count === MAX_SELECTION && (state.service === 'unavailable' || state.service === 'not-configured')) {
				message += ' · 공간 분석 서버를 사용할 수 없어 지금은 비교할 수 없습니다.';
			} else if (count < MAX_SELECTION) {
				message += ' · 한 건을 더 고르세요.';
			}
			el.historyText.textContent = message;
			el.historyRun.disabled = !controller.canRun();
		}

		function render(state) {
			var request = state.request;
			renderHistoryBar(state);
			el.viewCompare.setAttribute('data-state', request.phase);
			el.viewCompare.setAttribute('aria-busy', String(request.phase === 'loading'));
			el.run.disabled = !controller.canRun();
			el.includeUnchanged.checked = state.includeUnchanged;
			var done = request.phase === 'done' && !!request.view;
			show(el.empty, state.selection.length < MAX_SELECTION && !done);
			el.selection.textContent = '';
			state.selection.forEach(function (item) {
				el.selection.appendChild(make('li', null, (item.title || '분석 #' + item.analysisId) + ' · #' + item.analysisId
					+ (item.radiusMeters ? ' · 반경 ' + api.formatRadius(item.radiusMeters) : '')));
			});
			show(el.selection, state.selection.length > 0);
			var message = statusText(state);
			el.status.textContent = message;
			el.status.className = 'spatial__status' + (request.phase === 'error' || request.phase === 'blocked' ? ' is-error' : '');
			show(el.status, !!message);
			show(el.retry, request.phase === 'error' && !!request.error && request.error.retryable);
			show(el.result, done);
			if (!done) {
				rendered.view = null;
				return;
			}
			if (rendered.view !== request.view) {
				rendered.view = request.view;
				renderPair(request.view);
				renderBasis(request.view);
				renderMetrics(request.view);
				renderSummary(request.view);
				renderLists(request.view);
				renderNotes(request.view);
			}
		}

		var dashboard = win.gisSpatialDashboard;
		var controller = createController({
			api: api,
			base: base,
			fetchJson: function (url, signal) {
				return api.getJson(url, signal);
			},
			online: function () {
				return win.navigator.onLine !== false;
			},
			render: render,
			onSelectionChange: function (selection) {
				doc.dispatchEvent(new win.CustomEvent('gis:compareselection', { detail: { selection: selection } }));
			},
			refreshStatus: function () {
				if (win.gisSpatialDashboard && win.gisSpatialDashboard.refreshStatus) {
					win.gisSpatialDashboard.refreshStatus();
				}
			}
		});

		function openCompare() {
			showView('compare');
			if (analysis && analysis.openInfoPanel) {
				analysis.openInfoPanel('spatial');
			}
			controller.run();
		}

		el.historyRun.addEventListener('click', openCompare);
		el.run.addEventListener('click', function () {
			controller.run();
		});
		el.historyClear.addEventListener('click', controller.clearSelection);
		if (el.openHistory) {
			el.openHistory.addEventListener('click', function () {
				if (analysis && analysis.openInfoPanel) {
					analysis.openInfoPanel('history');
				}
			});
		}
		el.includeUnchanged.addEventListener('change', function () {
			controller.setIncludeUnchanged(el.includeUnchanged.checked);
		});
		if (el.retry) {
			el.retry.addEventListener('click', controller.retry);
		}
		doc.addEventListener('gis:spatialstatus', function (event) {
			controller.setService(event.detail && event.detail.state);
		});
		doc.addEventListener('gis:historychange', function (event) {
			if (event.detail && isValidId(event.detail.deletedId)) {
				controller.removeDeleted(event.detail.deletedId);
			}
		});

		if (dashboard && dashboard.getState) {
			controller.setService(dashboard.getState().service.state);
		} else {
			render(controller.getState());
		}

		win.gisCompare = {
			toggle: controller.toggle,
			isSelected: controller.isSelected,
			canSelect: controller.canSelect,
			clearSelection: controller.clearSelection,
			getState: controller.getState,
			showView: showView // 호환용: window.gisSpatialViews.show에 넘긴다.
		};
	}

	return {
		MAX_SELECTION: MAX_SELECTION,
		PAGE_SIZE: PAGE_SIZE,
		STATUS_LABELS: STATUS_LABELS,
		VWORLD_NOTE: VWORLD_NOTE,
		metricRows: metricRows,
		changeItem: changeItem,
		uncomparableItem: uncomparableItem,
		candidateItem: candidateItem,
		summaryItems: summaryItems,
		buildCompareView: buildCompareView,
		basisBox: basisBox,
		compareKey: compareKey,
		createController: createController,
		start: start
	};
});
