/*
 * GIS 3D 지도 - 공간 분석 API (8-6A)
 *
 * 브라우저는 Java 서버의 공간 분석 API만 호출한다. Python 분석 서버의 주소와 내부 토큰은 이 파일에도, 응답에도 없다.
 *   GET /api/spatial-analysis/status                    : { available, configured }
 *   GET /api/analysis-snapshots/{token}/statistics      : 저장 전 분석의 공간 통계
 *   GET /api/analyses/{id}/statistics                   : 저장된 분석의 공간 통계
 *   응답: { analysisIds, analysisService: { schemaVersion }, result: building-stats 응답 }
 *   오류: { error, message, analysisServiceError? }
 * - 오류 코드는 이 파일의 한국어 문구로만 안내한다. (서버 메시지를 그대로 쓰지 않는다)
 * - 숫자는 Intl.NumberFormat('ko-KR')로 표시한다. 점유율은 %(비율)이며 비교 화면의 %p(차이)와 구분한다.
 * - 화면(DOM)과 무관한 순수 함수만 두어 Node 내장 테스트(node --test)로 검사한다.
 */
(function (factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else {
		window.gisSpatialApi = api;
	}
})(function () {
	'use strict';

	var DEFAULT_BASE = '/api';

	var MESSAGES = {
		ANALYSIS_SERVICE_NOT_CONFIGURED: '공간 분석 서버 연동이 설정되지 않았습니다. 지도, 건물 검색, 반경 분석과 분석 이력은 계속 사용할 수 있습니다.',
		ANALYSIS_SERVICE_UNAVAILABLE: '공간 분석 서버에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다. 잠시 후 "다시 확인"을 누르세요.',
		ANALYSIS_SERVICE_BUSY: '공간 분석 서버가 다른 분석을 처리하고 있습니다. 잠시 후 다시 시도하세요.',
		ANALYSIS_SERVICE_TIMEOUT: '공간 분석 서버의 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.',
		ANALYSIS_TOO_LARGE: '분석 데이터가 너무 커서 공간 통계를 계산할 수 없습니다. 더 작은 반경으로 분석해 보세요.',
		ANALYSIS_DATA_UNSUPPORTED: '이 분석 데이터는 공간 통계를 지원하지 않습니다.',
		ANALYSIS_SERVICE_ERROR: '공간 분석 서버에서 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
		ANALYSIS_SERVICE_BAD_RESPONSE: '공간 분석 서버의 응답 형식이 올바르지 않습니다. 잠시 후 다시 시도하세요.',
		SNAPSHOT_EXPIRED: '저장 전 분석 결과가 만료되었습니다. (분석 후 30분이 지났거나 서버가 다시 시작됨) 반경 분석을 다시 실행하거나, 저장한 분석이면 분석 이력에서 여세요.',
		DB_UNAVAILABLE: '분석 이력 데이터베이스에 연결할 수 없습니다. 지도와 반경 분석은 계속 사용할 수 있습니다. 잠시 후 다시 시도하세요.',
		DB_ERROR: '분석 이력 데이터베이스 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
		ANALYSIS_NOT_FOUND: '이미 삭제되었거나 없는 분석 이력입니다.',
		STORED_DATA_INVALID: '저장된 분석 데이터를 읽을 수 없습니다.',
		INVALID_TOKEN: '저장 전 분석 정보가 올바르지 않습니다. 반경 분석을 다시 실행하세요.',
		INVALID_ID: '분석 이력 번호가 올바르지 않습니다.',
		INVALID_REQUEST: '요청 형식이 올바르지 않습니다. 페이지를 새로 고친 뒤 다시 시도하세요.'
	};

	// 본문에 오류 코드가 없을 때(프록시·기본 오류 페이지 등) 상태 코드로 판단한다.
	var STATUS_CODES = {
		404: 'ANALYSIS_NOT_FOUND', 410: 'SNAPSHOT_EXPIRED', 413: 'ANALYSIS_TOO_LARGE',
		422: 'ANALYSIS_DATA_UNSUPPORTED', 502: 'ANALYSIS_SERVICE_ERROR', 503: 'ANALYSIS_SERVICE_UNAVAILABLE',
		504: 'ANALYSIS_SERVICE_TIMEOUT'
	};

	// 잠시 후 같은 요청을 다시 보내면 성공할 수 있는 오류 ("다시 시도" 버튼 표시)
	var RETRYABLE = ['ANALYSIS_SERVICE_UNAVAILABLE', 'ANALYSIS_SERVICE_BUSY', 'ANALYSIS_SERVICE_TIMEOUT',
		'ANALYSIS_SERVICE_ERROR', 'ANALYSIS_SERVICE_BAD_RESPONSE', 'DB_UNAVAILABLE', 'DB_ERROR', 'NETWORK'];

	// 이 오류가 오면 Python 서비스 상태를 다시 확인한다.
	var SERVICE_DOWN = ['ANALYSIS_SERVICE_UNAVAILABLE', 'ANALYSIS_SERVICE_NOT_CONFIGURED'];

	var PYTHON_ERROR_CODE = /^[A-Z][A-Z_]{0,59}$/;

	/* ---------- URL ---------- */

	function statusUrl(base) {
		return (base || DEFAULT_BASE) + '/spatial-analysis/status';
	}

	/*
	 * target: { kind: 'saved', analysisId } | { kind: 'snapshot', token }
	 * 반환: 요청 URL, 대상이 올바르지 않으면 null
	 */
	function statisticsUrl(target, base) {
		var root = base || DEFAULT_BASE;
		if (!target) {
			return null;
		}
		if (target.kind === 'saved' && /^\d{1,18}$/.test(String(target.analysisId))) {
			return root + '/analyses/' + encodeURIComponent(target.analysisId) + '/statistics';
		}
		if (target.kind === 'snapshot' && typeof target.token === 'string' && target.token) {
			return root + '/analysis-snapshots/' + encodeURIComponent(target.token) + '/statistics';
		}
		return null;
	}

	/* ---------- 요청 ---------- */

	/*
	 * 반환 Promise: { ok, status, body } | { ok: false, network: true, aborted }
	 * fetchImpl: 테스트에서 대체할 수 있는 fetch
	 */
	function getJson(url, signal, fetchImpl) {
		var doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
		if (!doFetch) {
			return Promise.resolve({ ok: false, network: true, aborted: false });
		}
		return doFetch(url, { headers: { Accept: 'application/json' }, signal: signal }).then(function (response) {
			return response.json().catch(function () { return null; }).then(function (body) {
				return { ok: response.ok, status: response.status, body: body };
			});
		}, function (error) {
			return { ok: false, network: true, aborted: !!(error && error.name === 'AbortError') };
		});
	}

	/* ---------- 오류 ---------- */

	function errorCode(res) {
		if (!res || res.network) {
			return 'NETWORK';
		}
		if (res.body && typeof res.body.error === 'string' && res.body.error) {
			return res.body.error;
		}
		return STATUS_CODES[res.status] || 'HTTP_' + res.status;
	}

	/*
	 * 응답(res) → { code, message, retryable, serviceDown }. 메시지는 이 파일의 문구만 쓴다.
	 * 422의 Python 오류 코드(analysisServiceError)는 형식이 맞을 때만 괄호로 덧붙인다.
	 */
	function describeError(res, online) {
		var code = errorCode(res);
		var message;
		if (code === 'NETWORK') {
			message = online === false
				? '인터넷 연결이 끊어져 서버에 연결할 수 없습니다.'
				: '서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 다시 시도하세요.';
		} else if (MESSAGES[code]) {
			message = MESSAGES[code];
			var detail = res.body && res.body.analysisServiceError;
			if (code === 'ANALYSIS_DATA_UNSUPPORTED' && typeof detail === 'string' && PYTHON_ERROR_CODE.test(detail)) {
				message += ' (분석 서버 코드: ' + detail + ')';
			}
		} else {
			message = res.status >= 500
				? '서버 오류가 발생했습니다. (HTTP ' + res.status + ') 잠시 후 다시 시도하세요.'
				: '요청을 처리하지 못했습니다. (HTTP ' + res.status + ')';
		}
		return {
			code: code,
			message: message,
			retryable: RETRYABLE.indexOf(code) >= 0 || (res && res.status >= 500 && !MESSAGES[code]),
			serviceDown: SERVICE_DOWN.indexOf(code) >= 0
		};
	}

	/* ---------- 상태 ---------- */

	/*
	 * GET /api/spatial-analysis/status 응답 → 'available' | 'unavailable' | 'not-configured' | 'error'
	 * 'error': Java 서버에 연결하지 못했거나 응답을 해석할 수 없음 (Python 상태는 모름)
	 */
	function serviceState(res) {
		if (!res || !res.ok || !res.body || typeof res.body.available !== 'boolean'
				|| typeof res.body.configured !== 'boolean') {
			return 'error';
		}
		if (!res.body.configured) {
			return 'not-configured';
		}
		return res.body.available ? 'available' : 'unavailable';
	}

	var SERVICE_LABELS = {
		checking: '확인 중',
		available: '사용 가능',
		unavailable: '사용 불가',
		'not-configured': '설정되지 않음',
		error: '확인 실패'
	};

	var SERVICE_TEXTS = {
		checking: '공간 분석 서버 상태를 확인하고 있습니다...',
		available: '공간 통계를 계산할 수 있습니다.',
		unavailable: '공간 분석 서버가 실행 중이 아니거나 응답하지 않습니다. 지도, 건물 검색, 반경 분석과 분석 이력은 계속 사용할 수 있습니다.',
		'not-configured': '공간 분석 서버 연동이 설정되지 않았습니다. 지도, 건물 검색, 반경 분석과 분석 이력은 계속 사용할 수 있습니다.',
		error: '서버에 연결하지 못해 공간 분석 서버 상태를 확인할 수 없습니다.'
	};

	/* ---------- 숫자 표시 ---------- */

	var formatters = {};

	function formatter(digits) {
		if (!formatters[digits]) {
			formatters[digits] = new Intl.NumberFormat('ko-KR', {
				minimumFractionDigits: digits, maximumFractionDigits: digits
			});
		}
		return formatters[digits];
	}

	function isNumber(value) {
		return typeof value === 'number' && isFinite(value);
	}

	// 값이 없으면 fallback(기본 '-')
	function formatNumber(value, digits, fallback) {
		return isNumber(value) ? formatter(digits || 0).format(value) : (fallback == null ? '-' : fallback);
	}

	function formatArea(value) {
		return isNumber(value) ? formatNumber(value, 1) + ' m²' : '-';
	}

	// 점유율(비율)의 퍼센트 표시. 비교 화면의 퍼센트포인트(%p)와 다르다.
	function formatPercent(value) {
		return isNumber(value) ? formatNumber(value, 2) + '%' : '-';
	}

	function formatCount(value, unit) {
		return isNumber(value) ? formatNumber(value, 0) + (unit == null ? '개' : unit) : '-';
	}

	function formatFloors(value) {
		return isNumber(value) ? formatNumber(value, 1) + '층' : '정보 없음';
	}

	function formatRadius(meters) {
		if (!isNumber(meters)) {
			return '-';
		}
		return meters >= 1000 ? formatNumber(meters / 1000, meters % 1000 === 0 ? 0 : 2) + 'km ('
			+ formatNumber(meters, 0) + 'm)' : formatNumber(meters, 0) + 'm';
	}

	return {
		MESSAGES: MESSAGES,
		SERVICE_LABELS: SERVICE_LABELS,
		SERVICE_TEXTS: SERVICE_TEXTS,
		statusUrl: statusUrl,
		statisticsUrl: statisticsUrl,
		getJson: getJson,
		errorCode: errorCode,
		describeError: describeError,
		serviceState: serviceState,
		formatNumber: formatNumber,
		formatArea: formatArea,
		formatPercent: formatPercent,
		formatCount: formatCount,
		formatFloors: formatFloors,
		formatRadius: formatRadius
	};
});
