/*
 * GIS 3D 지도 - 격자 핫스팟 (8-7-5, 정보 패널 "공간 분석" 탭의 "핫스팟" 보기)
 *
 * - 지금 화면의 분석('gis:analysisresult')의 격자 핫스팟(Getis-Ord Gi* + 전역 Moran's I)을 요청해
 *   spatial-grid-renderer.js의 핫스팟 전용 renderer(gisGridModel.attachRenderer, 페이지당 하나)로 그린다.
 *     저장 전 분석: GET /api/analysis-snapshots/{token}/hotspot?cellSize=
 *     저장된 분석: GET /api/analyses/{id}/hotspot?cellSize=
 *   응답: { analysisIds, analysisService: { schemaVersion }, result } (result.status: OK, CONSTANT_VALUES,
 *   INSUFFICIENT_CELLS, PARTIAL_RESULT_BLOCKED). 부분 조회 결과의 차단도 HTTP 200이다.
 * - 지도에는 status가 OK일 때만 그린다. 다른 상태는 이전 핫스팟 도형도 지우고 사유만 안내한다. Moran's I도 OK일 때만
 *   보여 준다. 응답에 없는 값은 만들지 않고 '-'로 둔다.
 * - 그릴 때는 항상 styleFn: gisGridModel.hotspotStyle을 넘긴다(draw() 한 곳에서만 render를 부른다).
 * - 격자 밀집도(spatial-grid.js)와 함께 그리지 않는다. 그리기 직전에 'gis:spatiallayerchange' { layer: 'hotspot' }을
 *   보내 격자를 끄고(격자가 건물을 다시 보이게 한다) 그다음 분석 건물을 숨긴다. 다른 레이어가 켜졌다는 이벤트를
 *   받으면 핫스팟을 끈다(이벤트를 다시 보내지 않는다).
 * - 핫스팟 보기에서 다른 보기로 옮기면 요청을 취소하고 도형을 지운다(응답 캐시는 둔다). 정보 패널의 다른 탭으로
 *   옮기는 것만으로는 지우지 않는다.
 * - 요청: 같은 분석·셀 크기는 다시 요청하지 않고(현재 분석에 한해 셀 크기별 응답 최대 3개 캐시), AbortController +
 *   요청 번호 + 요청 키(generation, 분석 ID 또는 토큰, 셀 크기)로 늦은 응답을 무시한다. 저장('gis:analysissaved')하면
 *   같은 분석이므로 그린 도형과 캐시는 두고 이후 요청만 저장된 분석 ID로 한다.
 * - 측정 초기화('gis:measurereset')로 지워지면 표시 중일 때만 보관한 셀로 다시 그린다(styleFn을 다시 부르지 않는다).
 * - 셀 클릭은 spatial-grid.js와 같다: 측정·좌표 조회 중에는 무시하고, 반경 중심점이 바뀌지 않게 막는다.
 * - 구성: 순수 함수(응답 검사·화면 값) → createController(상태, DOM 없음) → connect(renderer와 문서 이벤트, 페이지당
 *   한 번) → start(핫스팟 패널 표시, onChange). 패널이 없는 페이지에서는 아무것도 만들지 않는다.
 * - 외부 값은 화면 값으로 만들 때 문자열·숫자만 쓰고 DOM에는 textContent로만 넣는다. 상태 표시에는 색과 함께
 *   [오류]·[분석 중] 같은 글자 표시를 붙인다. 순수 함수와 controller는 DOM 없이 node --test로 검사한다.
 */
(function (factory) {
	'use strict';
	var hotspot = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = hotspot;
	} else {
		hotspot.start(document, window);
	}
})(function () {
	'use strict';

	var DEFAULT_CELL_SIZE = 100;
	var MAX_CACHE = 3;
	var MEASURE_MODES = ['distance', 'area', 'coord'];
	var STATUSES = ['OK', 'CONSTANT_VALUES', 'INSUFFICIENT_CELLS', 'PARTIAL_RESULT_BLOCKED'];
	var CLASSES = ['HOT_99', 'HOT_95', 'HOT_90', 'NOT_SIGNIFICANT', 'COLD_90', 'COLD_95', 'COLD_99', 'NOT_TESTED'];
	var HOT = ['HOT_99', 'HOT_95', 'HOT_90'];
	var COLD = ['COLD_99', 'COLD_95', 'COLD_90'];
	var NOT_TESTED_REASONS = ['SMALL_BOUNDARY', 'NO_NEIGHBORS', 'UNDEFINED_VARIANCE', 'CONSTANT_VALUES',
		'INSUFFICIENT_CELLS'];
	var SIGNIFICANCE = 0.05;  // Moran's I 해석 문장의 기준 (p값 자체는 그대로 보여 준다)

	var CLASS_LABELS = {
		HOT_99: '핫스팟 (신뢰수준 99%)',
		HOT_95: '핫스팟 (신뢰수준 95%)',
		HOT_90: '핫스팟 (신뢰수준 90%)',
		NOT_SIGNIFICANT: '유의하지 않음 (검정함)',
		COLD_90: '콜드스팟 (신뢰수준 90%)',
		COLD_95: '콜드스팟 (신뢰수준 95%)',
		COLD_99: '콜드스팟 (신뢰수준 99%)',
		NOT_TESTED: '검정하지 않음'
	};

	var REASON_LABELS = {
		SMALL_BOUNDARY: '반경 원 안 면적이 셀의 25% 미만인 경계 셀',
		NO_NEIGHBORS: '인접한(8방향) 분석 셀이 없음',
		UNDEFINED_VARIANCE: '이웃 구성 때문에 Gi* 분산을 계산할 수 없음',
		CONSTANT_VALUES: '모든 셀의 점유율이 같아 계산하지 않음',
		INSUFFICIENT_CELLS: '검정할 수 있는 셀이 너무 적어 계산하지 않음'
	};

	var MESSAGES = {
		OK: '',
		PARTIAL_RESULT_BLOCKED: '부분 조회 결과라 핫스팟과 Moran\'s I를 계산하지 않았습니다. 관측되지 않은 건물이 특정 지역에 몰려 있을 수 있어 '
			+ '유의한 군집이 있는 것처럼 보일 수 있기 때문입니다. 반경을 줄이는 등 전체를 조회한 결과로 다시 분석하세요.',
		CONSTANT_VALUES: '모든 셀의 점유율이 같아(분산 0, 예: 건물이 없음) 핫스팟과 Moran\'s I를 계산할 수 없습니다. 지도에는 표시하지 않습니다.',
		INSUFFICIENT_CELLS: '검정할 수 있는 셀이 너무 적어 핫스팟과 Moran\'s I를 계산할 수 없습니다. 지도에는 표시하지 않습니다.'
	};

	var INTEGRITY_MESSAGE = '핫스팟 응답의 형식이나 셀 수가 맞지 않아 표시하지 않았습니다. 다시 시도하세요.';
	var GEOMETRY_EXCLUDED = 'PYTHON_GEOMETRY_EXCLUDED';

	function isObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	function isNumber(value) {
		return typeof value === 'number' && isFinite(value);
	}

	function isCount(value) {
		return isNumber(value) && value >= 0 && Math.floor(value) === value;
	}

	function text(value) {
		return typeof value === 'string' ? value : '';
	}

	/* ---------- 분석 대상과 캐시 키 (순수 함수) ---------- */

	/* gis:analysisresult detail → { generation, kind: 'saved' | 'snapshot', analysisId, token } 또는 null */
	function targetOf(detail) {
		var source = detail && detail.source;
		if (source === 'saved' && detail.analysisId != null) {
			return { generation: detail.generation, kind: 'saved', analysisId: detail.analysisId, token: null };
		}
		if (source === 'live') {
			return { generation: detail.generation, kind: 'snapshot', analysisId: null, token: detail.analysisToken || null };
		}
		return null;
	}

	function analysisKey(target) {
		if (!target) {
			return null;
		}
		return target.generation + ':' + (target.kind === 'saved' ? 'id:' + target.analysisId : 'token:' + target.token);
	}

	/* 요청 키: 분석(generation + ID 또는 토큰) + 셀 크기 */
	function cacheKey(targetKey, cellSize) {
		return targetKey == null ? null : targetKey + ':' + cellSize;
	}

	/* ---------- 응답 검사 (순수 함수) ---------- */

	/*
	 * Java 응답 { result } → { ok: true, result } 또는 { ok: false, reason }
	 * Java가 Python 응답의 불변식을 이미 검사하므로 화면이 기대는 최소한만 다시 본다.
	 *   status 4종, 요청한 셀 크기, cells(FeatureCollection), summary·completeness·blockedReasons
	 *   차단: 셀 0개, completeness.complete === false
	 *   그 밖: grid.returnedCellCount = summary.cellCount = 셀 수, OK이면 moran 객체
	 */
	function validateResponse(body, cellSize) {
		var result = isObject(body) ? body.result : null;
		if (!isObject(result) || !isObject(result.cells) || result.cells.type !== 'FeatureCollection'
				|| !Array.isArray(result.cells.features) || !isObject(result.summary) || !isObject(result.completeness)
				|| !Array.isArray(result.blockedReasons)) {
			return { ok: false, reason: 'structure' };
		}
		if (STATUSES.indexOf(result.status) < 0) {
			return { ok: false, reason: 'status' };
		}
		if (cellSize != null && result.cellSizeMeters !== cellSize) {
			return { ok: false, reason: 'cellSize' };
		}
		var count = result.cells.features.length;
		if (result.status === 'PARTIAL_RESULT_BLOCKED') {
			if (count !== 0 || result.completeness.complete !== false) {
				return { ok: false, reason: 'blocked' };
			}
			return { ok: true, result: result };
		}
		if (!isObject(result.grid) || result.grid.returnedCellCount !== count || result.summary.cellCount !== count) {
			return { ok: false, reason: 'count' };
		}
		if (result.status === 'OK' && !isObject(result.moran)) {
			return { ok: false, reason: 'structure' };
		}
		return { ok: true, result: result };
	}

	/* ---------- 화면 값 (순수 함수) ---------- */

	/*
	 * 확률(p, q) 표시: 0.01 이상은 소수 셋째 자리, 그보다 작으면 유효숫자 3자리(0.001, 0.0099)로 0처럼 보이지 않게 한다.
	 * 0.0001 미만은 지수 표기. 값이 없으면 '-'
	 */
	function formatProbability(value, api) {
		if (!isNumber(value)) {
			return '-';
		}
		if (value === 0 || value >= 0.01) {
			return api.formatNumber(value, 3);
		}
		if (value >= 0.0001) {
			return String(Number(value.toPrecision(3)));
		}
		return value.toExponential(2);
	}

	/* 클래스별 셀 수 [{ key, label, count(없으면 null), group: 'hot' | 'cold' | 'notSignificant' | 'notTested' }] */
	function classCounts(summary) {
		var classes = isObject(summary) && isObject(summary.classes) ? summary.classes : {};
		return CLASSES.map(function (key) {
			var group = HOT.indexOf(key) >= 0 ? 'hot' : COLD.indexOf(key) >= 0 ? 'cold'
				: key === 'NOT_TESTED' ? 'notTested' : 'notSignificant';
			return { key: key, label: CLASS_LABELS[key], count: isCount(classes[key]) ? classes[key] : null, group: group };
		});
	}

	/* 여러 클래스 셀 수의 합, 하나라도 없으면 null */
	function sumOf(counts, keys) {
		var total = 0;
		for (var i = 0; i < counts.length; i++) {
			if (keys.indexOf(counts[i].key) >= 0) {
				if (counts[i].count === null) {
					return null;
				}
				total += counts[i].count;
			}
		}
		return total;
	}

	/* 검정하지 않은 셀의 사유별 수 [{ reason, label, count }] (0인 사유는 뺀다) */
	function notTestedCounts(summary) {
		var reasons = isObject(summary) && isObject(summary.notTestedReasons) ? summary.notTestedReasons : {};
		return NOT_TESTED_REASONS.filter(function (reason) {
			return isCount(reasons[reason]) && reasons[reason] > 0;
		}).map(function (reason) {
			return { reason: reason, label: REASON_LABELS[reason], count: reasons[reason] };
		});
	}

	/*
	 * 전역 Moran's I 표시 값 (status OK이고 i, expected, pValue가 숫자일 때만, 아니면 null)
	 * { rows: [{ label, value }], interpretation, scope, pAtMinimum }
	 * 해석 문장은 I와 E[I]의 대소와 p ≤ 0.05 여부로만 고른다(원인은 말하지 않는다).
	 */
	function moranView(result, api) {
		if (!isObject(result) || result.status !== 'OK' || !isObject(result.moran)) {
			return null;
		}
		var m = result.moran;
		if (!isNumber(m.i) || !isNumber(m.expected) || !isNumber(m.pValue)) {
			return null;
		}
		var permutations = isObject(result.method) && isCount(result.method.permutations) && result.method.permutations > 0
			? result.method.permutations : null;
		var pAtMinimum = permutations !== null && Math.abs(m.pValue - 1 / (permutations + 1)) <= 1e-9;
		var interpretation;
		if (m.pValue <= SIGNIFICANCE && m.i > m.expected) {
			interpretation = '점유율이 비슷한 셀끼리 모여 있는 경향(양의 공간 자기상관)이 순열 검정에서 유의했습니다(p ≤ 0.05).';
		} else if (m.pValue <= SIGNIFICANCE && m.i < m.expected) {
			interpretation = '점유율이 서로 다른 셀이 이웃하는 경향(음의 공간 자기상관)이 순열 검정에서 유의했습니다(p ≤ 0.05).';
		} else {
			interpretation = '셀 점유율의 공간 배치가 무작위 배치와 유의하게 다르다고 보기 어렵습니다(p > 0.05).';
		}
		return {
			rows: [
				{ label: 'Moran\'s I', value: api.formatNumber(m.i, 4) },
				{ label: '기대값 E[I]', value: api.formatNumber(m.expected, 4) },
				{ label: '순열 검정 p값 (양측)', value: formatProbability(m.pValue, api)
					+ (pAtMinimum ? ' (순열 ' + api.formatNumber(permutations, 0) + '회에서 가능한 최솟값)' : '') },
				{ label: '순열 횟수', value: permutations === null ? '-' : api.formatNumber(permutations, 0) + '회' },
				{ label: '시뮬레이션 z', value: isNumber(m.zSimulated) ? api.formatNumber(m.zSimulated, 2) : '계산되지 않음' }
			],
			interpretation: interpretation,
			scope: 'Moran\'s I는 분석 영역 전체에 대한 하나의 값입니다. 지도의 셀 색상(셀별 Getis-Ord Gi*)과는 다른 통계입니다.',
			pAtMinimum: pAtMinimum
		};
	}

	/* 차단 사유 문장: Java의 불완전 사유 메시지 + Python이 도형을 뺀 경우 (알 수 없는 코드는 코드 그대로) */
	function blockedReasonTexts(result, api) {
		var completeness = isObject(result.completeness) ? result.completeness : {};
		var reasons = Array.isArray(completeness.reasons) ? completeness.reasons.filter(isObject) : [];
		var list = [];
		(Array.isArray(result.blockedReasons) ? result.blockedReasons : []).forEach(function (code) {
			if (code === GEOMETRY_EXCLUDED) {
				var n = completeness.pythonGeometryExcluded;
				list.push('분석 서버가 복구할 수 없는 건물 도형이' + (isCount(n) ? ' ' + api.formatCount(n) : '')
					+ ' 있어 전체 건물을 분석할 수 없습니다.');
				return;
			}
			var match = reasons.filter(function (reason) {
				return reason.code === code;
			})[0];
			list.push(match && text(match.message) ? text(match.message) : '불완전 사유: ' + String(code));
		});
		return list;
	}

	/*
	 * result → 화면 값 (status별)
	 * { status, drawable, message, complete, sourceComplete, pythonGeometryExcluded, blockedReasons, reasonTexts,
	 *   counts: { cellCount, studyCellCount, testedCellCount, minTestedCells } | null (차단),
	 *   classes: classCounts | null (OK만), hotCount, coldCount (OK만), notTested: [...] | null (차단),
	 *   moran: moranView | null (OK만), warnings: [{ code, message, count }], description, limitations: [] }
	 */
	function interpret(result, api) {
		var status = result.status;
		var blocked = status === 'PARTIAL_RESULT_BLOCKED';
		var ok = status === 'OK';
		var summary = isObject(result.summary) ? result.summary : {};
		var method = isObject(result.method) ? result.method : {};
		var completeness = isObject(result.completeness) ? result.completeness : {};
		var counts = blocked ? null : {
			cellCount: isCount(summary.cellCount) ? summary.cellCount : null,
			studyCellCount: isCount(summary.studyCellCount) ? summary.studyCellCount : null,
			testedCellCount: isCount(summary.testedCellCount) ? summary.testedCellCount : null,
			minTestedCells: isCount(method.minTestedCells) ? method.minTestedCells : null
		};
		var message = MESSAGES[status] || '';
		if (status === 'INSUFFICIENT_CELLS' && counts.studyCellCount !== null && counts.minTestedCells !== null) {
			message = '검정할 수 있는 셀이 ' + api.formatCount(counts.studyCellCount) + '로 최소 '
				+ api.formatCount(counts.minTestedCells) + '보다 적어 핫스팟과 Moran\'s I를 계산할 수 없습니다. '
				+ '더 큰 반경이나 더 작은 셀 크기로 다시 시도하세요. 지도에는 표시하지 않습니다.';
		}
		var classes = ok ? classCounts(summary) : null;
		return {
			status: status,
			drawable: ok,
			message: message,
			complete: completeness.complete === true,
			sourceComplete: typeof completeness.sourceComplete === 'boolean' ? completeness.sourceComplete : null,
			pythonGeometryExcluded: isCount(completeness.pythonGeometryExcluded) ? completeness.pythonGeometryExcluded : null,
			blockedReasons: (Array.isArray(result.blockedReasons) ? result.blockedReasons : []).map(String),
			reasonTexts: blocked ? blockedReasonTexts(result, api) : [],
			counts: counts,
			classes: classes,
			hotCount: ok ? sumOf(classes, HOT) : null,
			coldCount: ok ? sumOf(classes, COLD) : null,
			notTested: blocked ? null : notTestedCounts(summary),
			moran: ok ? moranView(result, api) : null,
			warnings: (Array.isArray(result.warnings) ? result.warnings : []).filter(isObject).map(function (w) {
				return { code: text(w.code), message: text(w.message), count: isCount(w.count) ? w.count : null };
			}),
			description: text(method.description),
			limitations: (Array.isArray(method.limitations) ? method.limitations : []).filter(function (line) {
				return typeof line === 'string' && line;
			})
		};
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
				col: p.col, row: p.row, hotspotClass: p.hotspotClass, giZ: p.giZ, pValue: p.pValue, qValue: p.qValue,
				reason: p.reason, neighborCount: p.neighborCount, coverageRatio: p.coverageRatio, domainRatio: p.domainRatio,
				boundary: p.boundary === true, smallBoundary: p.smallBoundary === true
			};
		});
		return index;
	}

	/* 셀 상세 → { id, title, hotspotClass, rows: [{ label, value }], notes: [] } */
	function cellDetail(id, props, cellSize, api) {
		var p = props || {};
		var cls = CLASSES.indexOf(p.hotspotClass) >= 0 ? p.hotspotClass : null;
		var rows = [{ label: '분류', value: cls ? CLASS_LABELS[cls] : '알 수 없음' }];
		var notes = [];
		if (cls === 'NOT_TESTED') {
			rows.push({ label: '검정하지 않은 사유', value: REASON_LABELS[p.reason] || '-' });
		} else if (cls) {
			rows.push({ label: 'Gi* z점수', value: isNumber(p.giZ) ? api.formatNumber(p.giZ, 2) : '-' });
			rows.push({ label: 'p값 (정규 근사, 보정 전)', value: formatProbability(p.pValue, api) });
			rows.push({ label: 'q값 (다중 검정 보정, 분류 기준)', value: formatProbability(p.qValue, api) });
			rows.push({ label: '이웃 셀 수', value: api.formatCount(p.neighborCount) });
			notes.push('q값은 검정한 모든 셀에 Benjamini-Hochberg 다중 검정 보정을 적용한 값이며, 분류는 q값으로 정했습니다.');
			if (cls === 'NOT_SIGNIFICANT') {
				notes.push('검정했지만 신뢰수준 90%(q ≤ 0.10)에도 해당하지 않아 유의하지 않습니다.');
			}
			if (p.boundary) {
				notes.push('반경 경계에 걸친 셀입니다. 경계 셀의 결과는 원이 셀을 자르는 위치의 영향을 받을 수 있습니다.');
			}
		}
		rows.push({ label: '셀 점유율', value: isNumber(p.coverageRatio) ? api.formatPercent(p.coverageRatio * 100) : '-' });
		rows.push({ label: '원 안 면적 비율', value: isNumber(p.domainRatio) ? api.formatPercent(p.domainRatio * 100) : '-' });
		rows.push({ label: '위치', value: '동쪽 ' + p.col + '번째, 북쪽 ' + p.row + '번째 (중심 셀 0, 0)' });
		return {
			id: String(id),
			title: '셀 ' + String(id) + ' (' + api.formatNumber(cellSize, 0) + 'm)',
			hotspotClass: cls,
			rows: rows,
			notes: notes
		};
	}

	var STATUS_LABELS = {
		PARTIAL_RESULT_BLOCKED: '부분 결과 차단',
		CONSTANT_VALUES: '분석 불가',
		INSUFFICIENT_CELLS: '분석 불가'
	};

	/*
	 * 상태 문구 → { kind, label, text } 또는 null. label은 색이 없어도 상태를 알 수 있게 문구 앞에 붙인다.
	 * kind: blocked(서버 사용 불가) | error | loading | drawing | warning | unavailable(통계 불가·차단 응답)
	 */
	function statusInfo(state, api) {
		var request = state.request;
		if (request.phase === 'blocked') {
			return { kind: 'blocked', label: '사용 불가',
				text: '공간 분석 서버를 사용할 수 없어 핫스팟을 분석할 수 없습니다. 지도, 반경 분석과 분석 이력은 계속 사용할 수 있습니다.' };
		}
		if (request.phase === 'error') {
			return { kind: 'error', label: '오류', text: request.error ? request.error.message : '' };
		}
		if (request.phase === 'loading') {
			return { kind: 'loading', label: '분석 중',
				text: '격자 핫스팟을 계산하고 있습니다... (셀 ' + api.formatNumber(request.size, 0) + 'm)' };
		}
		var drawing = state.drawing;
		if (drawing.phase === 'drawing') {
			return { kind: 'drawing', label: '표시 중', text: '지도에 핫스팟 격자를 그리고 있습니다... ('
				+ api.formatNumber(drawing.created, 0) + ' / ' + api.formatNumber(drawing.total, 0) + ')' };
		}
		if (drawing.phase === 'failed' || drawing.phase === 'unsupported') {
			return { kind: 'error', label: '오류', text: '지도에 핫스팟을 그리지 못했습니다. 지도가 표시된 뒤 다시 실행하세요.' };
		}
		if (drawing.phase === 'done' && drawing.errors > 0) {
			return { kind: 'warning', label: '주의', text: '셀 ' + api.formatNumber(drawing.errors, 0) + '개를 지도에 그리지 못했습니다.' };
		}
		var outcome = state.outcome;
		if (outcome && !outcome.drawable && outcome.message) {
			return { kind: 'unavailable', label: STATUS_LABELS[outcome.status] || '분석 불가', text: outcome.message };
		}
		return null;
	}

	/*
	 * 지도에 그리지 않는 응답의 안내 상자 → { title, lines: [], rows: [{ label, value }] } 또는 null(OK, 결과 없음)
	 * 차단: 사유 문장과 완전성 정보. 통계 불가: 셀 수와 검정하지 않은 사유.
	 */
	function noticeBox(outcome, api) {
		if (!outcome || outcome.drawable) {
			return null;
		}
		if (outcome.status === 'PARTIAL_RESULT_BLOCKED') {
			return {
				title: '부분 조회 결과라 핫스팟을 분석하지 않았습니다',
				lines: outcome.reasonTexts,
				rows: [
					{ label: '원본 반경 분석', value: outcome.sourceComplete === true ? '전체 조회'
						: outcome.sourceComplete === false ? '부분 조회' : '-' },
					{ label: '핫스팟 입력', value: outcome.complete ? '완전' : '불완전 (분석 차단)' },
					{ label: '분석 서버가 제외한 건물 도형', value: outcome.pythonGeometryExcluded === null ? '확인 전에 차단'
						: api.formatCount(outcome.pythonGeometryExcluded) }
				]
			};
		}
		var c = outcome.counts || {};
		return {
			title: '이 분석에서는 핫스팟 통계가 성립하지 않습니다',
			lines: (outcome.notTested || []).map(function (item) {
				return item.label + ': ' + api.formatCount(item.count);
			}),
			rows: [
				{ label: '전체 셀', value: api.formatCount(c.cellCount) },
				{ label: '연구 셀 (작은 경계 셀 제외)', value: api.formatCount(c.studyCellCount) },
				{ label: '최소 검정 셀', value: api.formatCount(c.minTestedCells) }
			]
		};
	}

	/* 결과 요약 카드 [{ label, value, note }] (OK만) */
	function summaryCards(outcome, api) {
		if (!outcome || !outcome.drawable || !outcome.counts) {
			return [];
		}
		var c = outcome.counts;
		return [
			{ label: '핫스팟 셀', value: api.formatCount(outcome.hotCount), note: '신뢰수준 90% 이상' },
			{ label: '콜드스팟 셀', value: api.formatCount(outcome.coldCount), note: '신뢰수준 90% 이상' },
			{ label: '검정한 셀', value: api.formatCount(c.testedCellCount), note: '연구 셀 ' + api.formatCount(c.studyCellCount) },
			{ label: '전체 셀', value: api.formatCount(c.cellCount), note: '검정하지 않은 셀 포함' }
		];
	}

	/* 그린 결과 안내: 뺀 셀, 상한 */
	function notices(prepared, api) {
		var list = [];
		if (prepared.invalid > 0) {
			list.push('좌표나 분류가 올바르지 않은 셀 ' + api.formatCount(prepared.invalid) + '는 표시하지 않았습니다.');
		}
		if (prepared.truncated > 0) {
			list.push('지도 표시 상한(' + api.formatCount(prepared.maxCells) + ')을 넘어 중심에서 먼 셀 '
				+ api.formatCount(prepared.truncated) + '는 표시하지 않았습니다.');
		}
		return list;
	}

	/* ---------- 상태 관리 (DOM 없음) ---------- */

	/*
	 * deps: {
	 *   api, model(prepareHotspotCells, hotspotStyle), renderer(핫스팟 전용), analysisRenderer() (setBuildingsVisible),
	 *   analysis() (suppressNextMapClick), mode(), fetchJson(url, signal), base, online(), onChange(state),
	 *   refreshStatus(), dispatchLayer(layer), openView()
	 * }
	 * request.phase: idle | loading | done | error | blocked
	 * drawing.phase: none | drawing | done | cancelled | failed | unsupported
	 * display: 핫스팟 도형이 지도에 있음(또는 그리는 중) — 이때 분석 건물은 숨겨져 있다.
	 * outcome: 지금 보여 주는 응답의 화면 값(interpret), 없으면 null
	 */
	function createController(deps) {
		var api = deps.api;
		var state = {
			target: null,
			targetKey: null,
			active: false,
			cellSize: DEFAULT_CELL_SIZE,
			service: 'checking',
			display: false,
			cache: [],            // [{ size, result, index }] 현재 분석만
			request: { key: null, size: null, phase: 'idle', error: null },
			outcome: null,
			drawing: { phase: 'none', created: 0, total: 0 },
			prepared: null,
			notices: [],
			selected: null,
			requestCount: 0
		};
		var seq = 0;
		var controller = null;
		var drawSeq = 0;

		function notify() {
			if (deps.onChange) {
				deps.onChange(state);
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

		/* 핫스팟 도형과 리스너를 지우고, 숨겼던 분석 건물을 다시 보인다. */
		function clearMap() {
			drawSeq++;
			deps.renderer.clear();
			state.drawing = { phase: 'none', created: 0, total: 0 };
			state.prepared = null;
			state.notices = [];
			state.selected = null;
			if (state.display) {
				state.display = false;
				buildings(true);
			}
		}

		/* 요청 취소 + 도형 정리 + 표시한 결과 지우기 (캐시는 둔다) */
		function reset() {
			abort();
			clearMap();
			state.outcome = null;
			state.request = { key: null, size: null, phase: 'idle', error: null };
		}

		function serviceBlocked() {
			return state.service === 'unavailable' || state.service === 'not-configured';
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

		/* OK 응답만 그린다. render는 여기서만 부르고 항상 hotspotStyle을 넘긴다. */
		function draw(entry) {
			var prepared = deps.model.prepareHotspotCells(entry.result);
			if (!state.display) {
				// 격자를 먼저 끈다(격자가 건물을 다시 보이게 한다). 그다음 핫스팟이 건물을 숨긴다.
				if (deps.dispatchLayer) {
					deps.dispatchLayer('hotspot');
				}
				state.display = true;
				buildings(false);
			}
			var mySeq = ++drawSeq;
			state.prepared = { total: prepared.total, invalid: prepared.invalid, available: prepared.available,
				shown: prepared.shown, truncated: prepared.truncated, maxCells: prepared.maxCells };
			state.notices = notices(prepared, api);
			state.selected = null;
			state.drawing = { phase: 'drawing', created: 0, total: prepared.shown };
			return deps.renderer.render(prepared.cells, {
				styleFn: deps.model.hotspotStyle,
				onProgress: function (progress) {
					if (mySeq === drawSeq) {
						state.drawing.created = progress.created;
						notify();
					}
				}
			}).then(function (result) {
				if (mySeq !== drawSeq) {
					return;
				}
				state.drawing = { phase: result.status, created: result.created, total: result.total, errors: result.errors };
				notify();
			});
		}

		/* 응답 하나를 화면에 반영: OK면 그리고, 아니면 이전 도형까지 지우고 사유만 남긴다. */
		function present(entry) {
			state.outcome = interpret(entry.result, api);
			state.selected = null;
			if (state.outcome.drawable) {
				draw(entry);
			} else {
				clearMap();
			}
			notify();
		}

		function fetchHotspot(size) {
			var key = cacheKey(state.targetKey, size);
			if (state.request.key === key && state.request.phase === 'loading') {
				return; // 같은 분석·셀 크기를 이미 요청 중
			}
			var url = api.hotspotUrl(state.target, size, deps.base);
			abort();
			clearMap();
			state.outcome = null;
			if (!url) {
				state.request = { key: key, size: size, phase: 'error',
					error: api.describeError({ status: 400, body: { error: 'INVALID_TOKEN' } }) };
				notify();
				return;
			}
			var mySeq = seq;
			controller = typeof AbortController === 'function' ? new AbortController() : null;
			state.request = { key: key, size: size, phase: 'loading', error: null };
			state.requestCount++;
			notify();
			deps.fetchJson(url, controller ? controller.signal : undefined).then(function (res) {
				if (mySeq !== seq || key !== state.request.key || !state.active) {
					return; // 셀 크기·분석 변경, 보기 이탈, 다른 레이어, 저장 전환으로 대체된 응답
				}
				controller = null;
				if (res && res.aborted) {
					return;
				}
				var checked = res && res.ok ? validateResponse(res.body, size) : null;
				if (checked && checked.ok) {
					remember(size, checked.result);
					state.request.phase = 'done';
					if (state.cellSize === size) {
						present(cached(size));
					} else {
						notify();
					}
					return;
				}
				var error = checked
					? { code: 'HOTSPOT_INTEGRITY', message: INTEGRITY_MESSAGE, retryable: true, serviceDown: false }
					: api.describeError(res, deps.online ? deps.online() : true);
				state.request.phase = 'error';
				state.request.error = error;
				if (error.serviceDown && deps.refreshStatus) {
					deps.refreshStatus();
				}
				notify();
			});
		}

		/* 지금 셀 크기로 분석을 실행한다(캐시가 있으면 요청하지 않는다). 실행할 수 없으면 false. */
		function run() {
			if (!state.active || !state.target) {
				notify();
				return false;
			}
			if (serviceBlocked()) {
				state.request = { key: null, size: null, phase: 'blocked', error: null };
				notify();
				return false;
			}
			var size = state.cellSize;
			var entry = cached(size);
			if (entry) {
				abort();
				state.request = { key: cacheKey(state.targetKey, size), size: size, phase: 'done', error: null };
				present(entry);
				return true;
			}
			fetchHotspot(size);
			return true;
		}

		/* 셀 크기 선택. 결과를 보여 주는 중이거나 요청 중이면 새 크기로 다시 실행한다. */
		function setCellSize(size) {
			if (api.GRID_CELL_SIZES.indexOf(size) < 0 || size === state.cellSize) {
				return;
			}
			state.cellSize = size;
			if (state.outcome || state.request.phase === 'loading' || state.display) {
				run();
			} else {
				notify();
			}
		}

		/* gis:analysisresult detail */
		function setAnalysis(detail) {
			var target = targetOf(detail);
			var key = analysisKey(target);
			if (key === state.targetKey) {
				notify();
				return;
			}
			// 분석이 바뀌었다(새 분석, 저장본 열기, 초기화): 요청·캐시·도형·결과를 모두 정리한다.
			reset();
			state.target = target;
			state.targetKey = key;
			state.cache = [];
			notify();
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
			// 같은 분석이므로 그린 도형과 캐시는 그대로 둔다. 스냅샷 요청이 진행 중이었으면 ID로 다시 요청한다.
			if (state.request.phase === 'loading') {
				var size = state.request.size;
				abort();
				state.request = { key: null, size: null, phase: 'idle', error: null };
				fetchHotspot(size);
				return;
			}
			if (state.request.key) {
				state.request.key = cacheKey(state.targetKey, state.request.size);
			}
			notify();
		}

		function setService(serviceState) {
			state.service = serviceState;
			if (state.request.phase === 'blocked' && !serviceBlocked() && serviceState !== 'checking') {
				state.request = { key: null, size: null, phase: 'idle', error: null };
			}
			notify();
		}

		/* gis:spatialviewchange: 핫스팟 보기를 떠나면 요청을 취소하고 도형과 결과를 지운다(캐시는 둔다). */
		function setView(view) {
			var active = view === 'hotspot';
			if (active === state.active) {
				return;
			}
			state.active = active;
			if (!active) {
				reset();
			}
			notify();
		}

		/* gis:spatiallayerchange: 격자가 켜졌으면 핫스팟 요청·도형·결과를 지운다. 이벤트를 다시 보내지 않는다. */
		function layerChanged(layer) {
			if (layer !== 'grid' || (!state.display && state.request.phase !== 'loading' && !state.outcome)) {
				return;
			}
			reset();
			notify();
		}

		/* "지도에서 지우기" */
		function clear() {
			reset();
			notify();
		}

		/* 측정 초기화로 엔진 도형이 모두 지워진 뒤: 표시 중이면 보관한 셀로 다시 그린다. */
		function measureReset() {
			if (!state.display || !deps.renderer.hasCells()) {
				return false;
			}
			var mySeq = ++drawSeq;
			state.drawing = { phase: 'drawing', created: 0, total: state.prepared ? state.prepared.shown : 0 };
			notify();
			deps.renderer.restore({
				onProgress: function (progress) {
					if (mySeq === drawSeq) {
						state.drawing.created = progress.created;
						notify();
					}
				}
			}).then(function (result) {
				if (mySeq === drawSeq) {
					state.drawing = { phase: result.status, created: result.created, total: result.total, errors: result.errors };
					notify();
				}
			});
			return true;
		}

		/* 셀 클릭 (핫스팟 renderer pick handler) */
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
			notify();
			if (state.selected && deps.openView) {
				deps.openView();
			}
			return !!state.selected;
		}

		function retry() {
			if (state.request.phase !== 'error') {
				return false;
			}
			state.request = { key: null, size: null, phase: 'idle', error: null };
			return run();
		}

		return {
			setAnalysis: setAnalysis,
			analysisSaved: analysisSaved,
			setService: setService,
			setView: setView,
			setCellSize: setCellSize,
			run: run,
			clear: clear,
			retry: retry,
			layerChanged: layerChanged,
			measureReset: measureReset,
			pick: pick,
			getState: function () {
				return state;
			}
		};
	}

	/* ---------- 브라우저 연결 ---------- */

	/*
	 * 핫스팟 renderer(페이지당 하나)와 controller를 만들고 문서 이벤트에 연결한다. 두 번 불러도 처음 것을 돌려준다.
	 * options: { onChange(state) (8-7-5b의 패널 표시), base('/api') }
	 * 반환(= window.gisSpatialHotspot): controller의 공개 메서드, 필요한 전역이 없으면 null
	 */
	function connect(doc, win, options) {
		if (win.gisSpatialHotspot) {
			return win.gisSpatialHotspot;
		}
		var api = win.gisSpatialApi;
		var model = win.gisGridModel;
		if (!api || !model || typeof model.attachRenderer !== 'function' || typeof model.hotspotStyle !== 'function') {
			return null;
		}
		var opts = options || {};
		var renderer = model.attachRenderer(win, doc);
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
			base: opts.base || '/api',
			online: function () {
				return !win.navigator || win.navigator.onLine !== false;
			},
			onChange: opts.onChange,
			refreshStatus: function () {
				if (win.gisSpatialDashboard && win.gisSpatialDashboard.refreshStatus) {
					win.gisSpatialDashboard.refreshStatus();
				}
			},
			dispatchLayer: function (layer) {
				doc.dispatchEvent(new win.CustomEvent('gis:spatiallayerchange', { detail: { layer: layer } }));
			},
			// 셀 정보를 보여 줄 핫스팟 보기와 공간 분석 탭을 연다. 작은 화면에서는 지도를 가리지 않도록 열지 않는다.
			openView: function () {
				if (win.gisLayout && typeof win.gisLayout.isMobile === 'function' && win.gisLayout.isMobile()) {
					return;
				}
				if (win.gisSpatialViews && typeof win.gisSpatialViews.show === 'function') {
					win.gisSpatialViews.show('hotspot');
				}
				if (analysis && typeof analysis.openInfoPanel === 'function') {
					analysis.openInfoPanel('spatial');
				}
			}
		});
		renderer.setPickHandler(controller.pick);
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
		doc.addEventListener('gis:spatialviewchange', function (event) {
			controller.setView(event.detail && event.detail.view);
		});
		doc.addEventListener('gis:spatiallayerchange', function (event) {
			controller.layerChanged(event.detail && event.detail.layer);
		});

		if (analysis && analysis.getCurrent) {
			controller.setAnalysis(analysis.getCurrent());
		}
		var dashboard = win.gisSpatialDashboard;
		controller.setService(dashboard && dashboard.getState ? dashboard.getState().service.state : 'checking');
		var views = win.gisSpatialViews;
		controller.setView(views && typeof views.current === 'function' ? views.current() : null);

		win.gisSpatialHotspot = {
			getState: controller.getState,
			run: controller.run,
			setCellSize: controller.setCellSize,
			clear: controller.clear,
			retry: controller.retry
		};
		return win.gisSpatialHotspot;
	}

	/* ---------- 화면 (브라우저) ---------- */

	/*
	 * 핫스팟 패널(id="spatial-view-hotspot")을 controller 상태로 그리고 버튼을 연결한다. 패널이 없는 페이지에서는
	 * renderer도 만들지 않는다. 외부 값은 모두 textContent로 넣는다.
	 */
	function start(doc, win) {
		var api = win.gisSpatialApi;
		var model = win.gisGridModel;
		var script = doc.currentScript;
		var $ = function (id) {
			return doc.getElementById(id);
		};
		var el = {
			view: $('spatial-view-hotspot'),
			empty: $('hotspot-empty'),
			sizes: [$('hotspot-size-50'), $('hotspot-size-100'), $('hotspot-size-200')],
			run: $('hotspot-run'),
			clear: $('hotspot-clear'),
			status: $('hotspot-status'),
			retry: $('hotspot-retry'),
			notice: $('hotspot-notice'),
			result: $('hotspot-result'),
			summary: $('hotspot-summary'),
			kpis: $('hotspot-kpis'),
			moran: $('hotspot-moran'),
			moranList: $('hotspot-moran-list'),
			moranText: $('hotspot-moran-text'),
			moranScope: $('hotspot-moran-scope'),
			notices: $('hotspot-notices'),
			detail: $('hotspot-detail'),
			legend: $('hotspot-legend'),
			legendUntested: $('hotspot-legend-untested'),
			limitations: $('hotspot-limitations'),
			method: $('hotspot-method'),
			limitationsList: $('hotspot-limitations-list')
		};
		if (!api || !model || typeof model.hotspotLegend !== 'function' || !el.view || !el.run || !el.status) {
			return null;
		}
		if (win.gisSpatialHotspot) {
			return win.gisSpatialHotspot;
		}
		var legendCounts = {};

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

		function rows(list, items) {
			list.textContent = '';
			items.forEach(function (row) {
				var item = make('div', 'info-list__row');
				item.appendChild(make('dt', null, row.label));
				item.appendChild(make('dd', null, row.value));
				list.appendChild(item);
			});
		}

		/* 범례는 한 번 만든다(색과 이름은 gisGridModel.hotspotLegend). 셀 수만 결과에 따라 바꾼다. */
		function buildLegend() {
			el.legend.textContent = '';
			if (el.legendUntested) {
				el.legendUntested.textContent = '';
			}
			model.hotspotLegend().forEach(function (item) {
				var li = make('li', 'grid-legend__item hotspot-legend__item');
				li.setAttribute('data-legend', item.key);
				var swatch = make('span', 'grid-legend__swatch');
				swatch.style.backgroundColor = 'rgba(' + item.rgba[0] + ', ' + item.rgba[1] + ', ' + item.rgba[2] + ', '
					+ (item.rgba[3] / 255).toFixed(2) + ')';
				li.appendChild(swatch);
				li.appendChild(make('span', 'grid-legend__label', item.label));
				var count = make('span', 'hotspot-legend__count');
				li.appendChild(count);
				legendCounts[item.key] = count;
				(item.group === 'notTested' && el.legendUntested ? el.legendUntested : el.legend).appendChild(li);
			});
		}

		function renderLegendCounts(outcome) {
			var counts = {};
			(outcome && outcome.classes ? outcome.classes : []).forEach(function (item) {
				counts[item.key] = item.count;
			});
			Object.keys(legendCounts).forEach(function (key) {
				var value = counts[key];
				legendCounts[key].textContent = typeof value === 'number' ? api.formatCount(value) : '';
			});
		}

		function serviceBlocked(state) {
			return state.service === 'unavailable' || state.service === 'not-configured';
		}

		function render(state) {
			var hasTarget = !!state.target;
			var loading = state.request.phase === 'loading';
			var outcome = state.outcome;
			el.view.setAttribute('data-state', !hasTarget ? 'empty' : loading ? 'loading'
				: state.request.phase === 'error' ? 'error' : outcome ? outcome.status.toLowerCase() : 'idle');
			el.view.setAttribute('aria-busy', String(loading || state.drawing.phase === 'drawing'));
			show(el.empty, !hasTarget);
			el.sizes.forEach(function (button) {
				if (button) {
					button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-cell-size')) === state.cellSize));
					button.disabled = !hasTarget;
				}
			});
			el.run.disabled = !hasTarget || loading || serviceBlocked(state);
			if (el.clear) {
				el.clear.disabled = !(state.display || outcome || loading);
			}

			var info = statusInfo(state, api);
			el.status.textContent = '';
			if (info) {
				el.status.appendChild(make('strong', 'hotspot-status__label', '[' + info.label + '] '));
				el.status.appendChild(make('span', null, info.text));
			}
			// is-error: 기존 공간 분석 보기와 같은 빨간 글자. 종류(is-{kind})는 글자 표시([오류] 등)와 함께 쓴다.
			el.status.className = 'spatial__status hotspot-status' + (info ? ' is-' + info.kind : '')
				+ (info && info.kind === 'blocked' ? ' is-error' : '');
			show(el.status, !!info);
			show(el.retry, state.request.phase === 'error' && !!state.request.error && state.request.error.retryable);

			var box = noticeBox(outcome, api);
			if (el.notice) {
				el.notice.textContent = '';
				if (box) {
					el.notice.appendChild(make('p', 'analysis__completeness-title', box.title));
					if (box.lines.length) {
						var lines = make('ul');
						box.lines.forEach(function (line) {
							lines.appendChild(make('li', null, line));
						});
						el.notice.appendChild(lines);
					}
					var list = make('dl', 'info-list hotspot-notice__list');
					rows(list, box.rows);
					el.notice.appendChild(list);
				}
				show(el.notice, !!box);
			}

			var cards = summaryCards(outcome, api);
			if (el.result) {
				if (el.summary) {
					el.summary.textContent = cards.length ? '셀 ' + api.formatNumber(state.cellSize, 0) + 'm · 표시 '
						+ api.formatCount(state.prepared ? state.prepared.shown : null) + ' / 전체 '
						+ api.formatCount(outcome.counts.cellCount) : '';
				}
				if (el.kpis) {
					el.kpis.textContent = '';
					cards.forEach(function (card) {
						var kpi = make('div', 'spatial-kpi');
						kpi.appendChild(make('span', 'spatial-kpi__label', card.label));
						kpi.appendChild(make('span', 'spatial-kpi__value', card.value));
						kpi.appendChild(make('span', 'spatial-kpi__note', card.note));
						el.kpis.appendChild(kpi);
					});
				}
				show(el.result, cards.length > 0);
			}

			var moran = outcome ? outcome.moran : null;
			if (el.moran) {
				if (el.moranList) {
					rows(el.moranList, moran ? moran.rows : []);
				}
				if (el.moranText) {
					el.moranText.textContent = moran ? moran.interpretation : '';
				}
				if (el.moranScope) {
					el.moranScope.textContent = moran ? moran.scope : '';
				}
				show(el.moran, !!moran);
			}

			var notes = (outcome && outcome.drawable ? state.notices : []).concat((outcome ? outcome.warnings : [])
				.map(function (w) {
					return w.message || w.code;
				}).filter(Boolean));
			if (el.notices) {
				el.notices.textContent = '';
				notes.forEach(function (note) {
					el.notices.appendChild(make('li', null, note));
				});
				show(el.notices, notes.length > 0);
			}

			if (el.detail) {
				el.detail.textContent = '';
				if (state.selected) {
					el.detail.appendChild(make('h3', 'analysis__subtitle', state.selected.title));
					var detailList = make('dl', 'info-list grid-detail__list');
					rows(detailList, state.selected.rows);
					el.detail.appendChild(detailList);
					state.selected.notes.forEach(function (note) {
						el.detail.appendChild(make('p', 'panel-hint', note));
					});
				}
				show(el.detail, !!state.selected);
			}

			renderLegendCounts(outcome);

			if (el.limitations) {
				if (el.method) {
					el.method.textContent = outcome ? outcome.description : '';
				}
				if (el.limitationsList) {
					el.limitationsList.textContent = '';
					(outcome ? outcome.limitations : []).forEach(function (line) {
						el.limitationsList.appendChild(make('li', null, line));
					});
				}
				show(el.limitations, !!outcome && (outcome.limitations.length > 0 || !!outcome.description));
			}
		}

		buildLegend();
		var hotspotApi = connect(doc, win, { onChange: render,
			base: (script && script.getAttribute('data-api-base')) || '/api' });
		if (!hotspotApi) {
			return null;
		}
		el.sizes.forEach(function (button) {
			if (button) {
				button.addEventListener('click', function () {
					hotspotApi.setCellSize(Number(button.getAttribute('data-cell-size')));
				});
			}
		});
		el.run.addEventListener('click', function () {
			hotspotApi.run();
		});
		if (el.clear) {
			el.clear.addEventListener('click', function () {
				hotspotApi.clear();
			});
		}
		if (el.retry) {
			el.retry.addEventListener('click', function () {
				hotspotApi.retry();
			});
		}
		render(hotspotApi.getState());
		return hotspotApi;
	}

	return {
		DEFAULT_CELL_SIZE: DEFAULT_CELL_SIZE,
		MAX_CACHE: MAX_CACHE,
		STATUSES: STATUSES,
		CLASSES: CLASSES,
		CLASS_LABELS: CLASS_LABELS,
		REASON_LABELS: REASON_LABELS,
		MESSAGES: MESSAGES,
		targetOf: targetOf,
		analysisKey: analysisKey,
		cacheKey: cacheKey,
		validateResponse: validateResponse,
		formatProbability: formatProbability,
		classCounts: classCounts,
		notTestedCounts: notTestedCounts,
		moranView: moranView,
		blockedReasonTexts: blockedReasonTexts,
		interpret: interpret,
		indexCells: indexCells,
		cellDetail: cellDetail,
		notices: notices,
		statusInfo: statusInfo,
		noticeBox: noticeBox,
		summaryCards: summaryCards,
		createController: createController,
		connect: connect,
		start: start
	};
});
