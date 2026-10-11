// node --test src/test/js  (Node.js 내장 테스트 러너, npm 패키지 없음)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '../../main/resources/static/js/spatial-api.js');
const api = require(SOURCE);

test('statistics URLs for snapshots and saved analyses', () => {
	assert.equal(api.statisticsUrl({ kind: 'saved', analysisId: 12 }), '/api/analyses/12/statistics');
	assert.equal(api.statisticsUrl({ kind: 'snapshot', token: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
		'/api/analysis-snapshots/0f8fad5b-d9cb-469f-a165-70867728950e/statistics');
	assert.equal(api.statisticsUrl({ kind: 'saved', analysisId: 7 }, '/ctx/api'), '/ctx/api/analyses/7/statistics');
	assert.equal(api.statisticsUrl({ kind: 'snapshot', token: 'a/b?c' }), '/api/analysis-snapshots/a%2Fb%3Fc/statistics');
	assert.equal(api.statusUrl('/ctx/api'), '/ctx/api/spatial-analysis/status');
	for (const invalid of [null, { kind: 'saved', analysisId: null }, { kind: 'saved', analysisId: '1;x' },
		{ kind: 'snapshot', token: null }, { kind: 'snapshot', token: '' }, { kind: 'other' }]) {
		assert.equal(api.statisticsUrl(invalid), null);
	}
});

test('every documented error code has its own Korean message', () => {
	const codes = ['ANALYSIS_SERVICE_NOT_CONFIGURED', 'ANALYSIS_SERVICE_UNAVAILABLE', 'ANALYSIS_SERVICE_BUSY',
		'ANALYSIS_SERVICE_TIMEOUT', 'ANALYSIS_TOO_LARGE', 'ANALYSIS_DATA_UNSUPPORTED', 'ANALYSIS_SERVICE_ERROR',
		'ANALYSIS_SERVICE_BAD_RESPONSE', 'SNAPSHOT_EXPIRED', 'DB_UNAVAILABLE', 'ANALYSIS_NOT_FOUND'];
	const messages = new Set();
	for (const code of codes) {
		const error = api.describeError({ ok: false, status: 503, body: { error: code, message: 'server text' } });
		assert.equal(error.code, code);
		assert.equal(error.message, api.MESSAGES[code]);
		assert.match(error.message, /[가-힣]/);
		assert.doesNotMatch(error.message, /server text/);  // the server message is never shown
		messages.add(error.message);
	}
	assert.equal(messages.size, codes.length);
});

test('status codes are used when the body has no error code', () => {
	const cases = { 404: 'ANALYSIS_NOT_FOUND', 410: 'SNAPSHOT_EXPIRED', 413: 'ANALYSIS_TOO_LARGE',
		422: 'ANALYSIS_DATA_UNSUPPORTED', 502: 'ANALYSIS_SERVICE_ERROR', 503: 'ANALYSIS_SERVICE_UNAVAILABLE',
		504: 'ANALYSIS_SERVICE_TIMEOUT' };
	for (const [status, code] of Object.entries(cases)) {
		assert.equal(api.describeError({ ok: false, status: Number(status), body: null }).code, code);
	}
	const unknown = api.describeError({ ok: false, status: 500, body: '<html>' });
	assert.equal(unknown.code, 'HTTP_500');
	assert.match(unknown.message, /HTTP 500/);
	assert.equal(unknown.retryable, true);
});

test('network failures, retry and service-down flags', () => {
	const offline = api.describeError({ ok: false, network: true }, false);
	assert.equal(offline.code, 'NETWORK');
	assert.match(offline.message, /인터넷/);
	assert.equal(offline.retryable, true);
	assert.match(api.describeError({ ok: false, network: true }, true).message, /서버에 연결할 수 없습니다/);

	const flags = (code) => api.describeError({ ok: false, status: 503, body: { error: code } });
	assert.equal(flags('ANALYSIS_SERVICE_BUSY').retryable, true);
	assert.equal(flags('ANALYSIS_SERVICE_TIMEOUT').retryable, true);
	assert.equal(flags('SNAPSHOT_EXPIRED').retryable, false);
	assert.equal(flags('ANALYSIS_TOO_LARGE').retryable, false);
	assert.equal(flags('ANALYSIS_NOT_FOUND').retryable, false);
	assert.equal(flags('ANALYSIS_SERVICE_UNAVAILABLE').serviceDown, true);
	assert.equal(flags('ANALYSIS_SERVICE_NOT_CONFIGURED').serviceDown, true);
	assert.equal(flags('ANALYSIS_SERVICE_BUSY').serviceDown, false);
});

test('422 shows the Python error code only when it is a plain code', () => {
	const ok = api.describeError({ ok: false, status: 422,
		body: { error: 'ANALYSIS_DATA_UNSUPPORTED', analysisServiceError: 'VALIDATION_ERROR' } });
	assert.match(ok.message, /\(분석 서버 코드: VALIDATION_ERROR\)$/);
	const odd = api.describeError({ ok: false, status: 422,
		body: { error: 'ANALYSIS_DATA_UNSUPPORTED', analysisServiceError: '<img src=x onerror=alert(1)>' } });
	assert.equal(odd.message, api.MESSAGES.ANALYSIS_DATA_UNSUPPORTED);
});

test('service state from the status response', () => {
	const res = (body) => ({ ok: true, status: 200, body });
	assert.equal(api.serviceState(res({ available: true, configured: true })), 'available');
	assert.equal(api.serviceState(res({ available: false, configured: true })), 'unavailable');
	assert.equal(api.serviceState(res({ available: false, configured: false })), 'not-configured');
	assert.equal(api.serviceState(res({ available: 'yes', configured: true })), 'error');
	assert.equal(api.serviceState({ ok: false, network: true }), 'error');
	assert.equal(api.serviceState({ ok: false, status: 500, body: null }), 'error');
	for (const state of ['checking', 'available', 'unavailable', 'not-configured', 'error']) {
		assert.ok(api.SERVICE_LABELS[state]);
		assert.ok(api.SERVICE_TEXTS[state]);
	}
	assert.equal(api.SERVICE_LABELS.available, '사용 가능');
	assert.equal(api.SERVICE_LABELS.unavailable, '사용 불가');
	assert.equal(api.SERVICE_LABELS['not-configured'], '설정되지 않음');
	assert.equal(api.SERVICE_LABELS.checking, '확인 중');
});

test('ko-KR number formats with units', () => {
	assert.equal(api.formatArea(13762.06), '13,762.1 m²');
	assert.equal(api.formatArea(0), '0.0 m²');
	assert.equal(api.formatArea(null), '-');
	assert.equal(api.formatPercent(2.54), '2.54%');
	assert.equal(api.formatPercent(0), '0.00%');
	assert.doesNotMatch(api.formatPercent(12.5), /%p/);
	assert.equal(api.formatFloors(4), '4.0층');
	assert.equal(api.formatFloors(null), '정보 없음');
	assert.equal(api.formatCount(4980), '4,980개');
	assert.equal(api.formatCount(3, '건'), '3건');
	assert.equal(api.formatCount(undefined), '-');
	assert.equal(api.formatRadius(500), '500m');
	assert.equal(api.formatRadius(1000), '1km (1,000m)');
	assert.equal(api.formatRadius(1250), '1.25km (1,250m)');
	assert.equal(api.formatNumber(NaN, 1), '-');
});

test('getJson reports bodies, non-JSON bodies, network errors and aborts', async () => {
	const response = (status, body) => ({ ok: status < 400, status, json: () => body });
	assert.deepEqual(await api.getJson('/x', undefined, () => Promise.resolve(response(200, Promise.resolve({ a: 1 })))),
		{ ok: true, status: 200, body: { a: 1 } });
	assert.deepEqual(await api.getJson('/x', undefined,
		() => Promise.resolve(response(502, Promise.reject(new SyntaxError('html'))))),
	{ ok: false, status: 502, body: null });
	assert.deepEqual(await api.getJson('/x', undefined, () => Promise.reject(new TypeError('failed'))),
		{ ok: false, network: true, aborted: false });
	const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
	assert.deepEqual(await api.getJson('/x', undefined, () => Promise.reject(abort)),
		{ ok: false, network: true, aborted: true });
	let seen;
	await api.getJson('/y', 'signal', (url, options) => {
		seen = { url, options };
		return Promise.resolve(response(200, Promise.resolve({})));
	});
	assert.equal(seen.url, '/y');
	assert.equal(seen.options.signal, 'signal');
	assert.equal(seen.options.headers.Accept, 'application/json');
});

test('the browser code never contains the Python address or the internal token header', () => {
	for (const file of ['spatial-api.js', 'spatial-dashboard.js']) {
		const source = fs.readFileSync(path.join(__dirname, '../../main/resources/static/js', file), 'utf8');
		assert.doesNotMatch(source, /8001|X-Internal-Token|internal\/v1|ANALYSIS_INTERNAL_TOKEN/);
		assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
	}
});
