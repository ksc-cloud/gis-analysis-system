// node --test src/test/js  (Node.js 내장 테스트 러너, npm 패키지 없음)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const api = require(path.join(__dirname, '../../main/resources/static/js/spatial-api.js'));
const dashboard = require(path.join(__dirname, '../../main/resources/static/js/spatial-dashboard.js'));
// A real building-stats response (Python compute_building_stats on a partial analysis) in the Java envelope.
const PARTIAL = require('./fixtures/building-stats-partial.json');

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

/* ---------- view ---------- */

test('building-stats fields are mapped to the dashboard', () => {
	const view = dashboard.buildView(PARTIAL);
	const r = PARTIAL.result;

	assert.equal(view.radiusMeters, r.radiusMeters);
	assert.equal(view.analyzed, r.counts.analyzed);
	assert.equal(view.total, r.counts.total);
	assert.equal(view.excluded, r.counts.excluded);
	assert.deepEqual(view.excludedByReason, { INVALID_GEOMETRY: 1 });
	assert.equal(view.unionArea, r.withinRadius.unionArea);
	assert.equal(view.coveragePercent, r.withinRadius.coveragePercent);
	assert.equal(view.averageArea, r.footprint.averageArea);
	assert.equal(view.averageFloors, r.floors.average);
	assert.equal(view.floorsWithData, r.floors.withData);
	assert.equal(view.floorsMissing, r.floors.withoutData);
	assert.deepEqual(view.missingBreakdown, r.floors.missingBreakdown);
	assert.equal(view.complete, false);
	assert.deepEqual(view.reasons.map((x) => x.code), ['PAGE_LIMIT']);
	// PARTIAL_RESULT is shown by the completeness box, the other Python warnings in the list.
	assert.deepEqual(view.warnings.map((w) => w.code),
		r.warnings.map((w) => w.code).filter((c) => c !== 'PARTIAL_RESULT'));
	assert.ok(view.warnings.every((w) => typeof w.message === 'string' && w.message.length > 0));
});

test('KPI cards: values, units and the partial-result note', () => {
	const cards = dashboard.kpis(dashboard.buildView(PARTIAL), api);
	const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));

	assert.deepEqual(cards.map((c) => c.key), ['radius', 'buildings', 'area', 'coverage', 'averageArea',
		'averageFloors', 'floorsMissing', 'excluded']);
	assert.equal(byKey.radius.value, '100m');
	assert.equal(byKey.buildings.value, '4개');
	assert.equal(byKey.buildings.note, '입력 5개');
	assert.equal(byKey.area.value, '796.6 m²');
	assert.equal(byKey.coverage.value, '2.54%');
	assert.equal(byKey.coverage.note, '관측된 건물 기준');
	assert.equal(byKey.averageFloors.value, '4.0층');
	assert.equal(byKey.averageFloors.note, '층수 정보가 있는 2개 기준');
	assert.equal(byKey.floorsMissing.value, '3개');
	assert.equal(byKey.floorsMissing.note, '정보 없음 1 · 0층 1 · 비정상 값 1');
	assert.equal(byKey.excluded.value, '1개');
	assert.equal(byKey.excluded.note, '도형 오류 1');
	for (const card of cards) {
		assert.doesNotMatch(card.value, /%p/);
	}
});

test('complete results and missing values', () => {
	const complete = JSON.parse(JSON.stringify(PARTIAL));
	complete.result.completeness.complete = true;
	complete.result.completeness.reasons = [];
	complete.result.footprint.averageArea = null;
	complete.result.floors.average = null;
	complete.result.floors.withData = 0;
	const byKey = Object.fromEntries(dashboard.kpis(dashboard.buildView(complete), api).map((c) => [c.key, c]));

	assert.equal(byKey.coverage.note, '반경 원 면적 대비');
	assert.equal(byKey.averageArea.value, '-');
	assert.equal(byKey.averageFloors.value, '정보 없음');
	assert.equal(byKey.averageFloors.note, '');
});

test('responses without the building-stats structure are rejected', () => {
	for (const body of [null, {}, { result: null }, { result: [] }, { result: { counts: {} } },
		{ result: { ...PARTIAL.result, withinRadius: null } }]) {
		assert.equal(dashboard.buildView(body), null);
	}
});

/* ---------- controller ---------- */

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Fake Java API: every request waits until the test answers it. */
function harness(options = {}) {
	const calls = [];
	let now = options.now || 1_000_000;
	const renders = [];
	const controller = dashboard.createController({
		api,
		base: '/api',
		fetchJson(url, signal) {
			return new Promise((resolve) => {
				const call = { url, signal, resolve, answered: false };
				calls.push(call);
				// ignoreAbort: like a browser without AbortController, a cancelled request still delivers its answer.
				if (signal && !options.ignoreAbort) {
					signal.addEventListener('abort', () => {
						if (!call.answered) {
							call.answered = true;
							resolve({ ok: false, network: true, aborted: true });
						}
					});
				}
			});
		},
		now: () => now,
		online: () => true,
		render: (state) => renders.push(state.stats.phase)
	});
	const pending = (fragment) => calls.filter((c) => !c.answered && c.url.includes(fragment));
	async function answer(fragment, res) {
		const call = pending(fragment)[0];
		assert.ok(call, 'no pending request for ' + fragment);
		call.answered = true;
		call.resolve(res);
		await flush();
	}
	return {
		controller, calls, renders, pending, answer,
		state: () => controller.getState(),
		advance(ms) {
			now += ms;
		},
		statsCalls: () => calls.filter((c) => c.url.includes('/statistics')),
		available: () => answer('/spatial-analysis/status', ok({ available: true, configured: true }))
	};
}

function ok(body) {
	return { ok: true, status: 200, body };
}

function fail(status, error) {
	return { ok: false, status, body: { error, message: 'x' } };
}

const live = (generation, token = TOKEN) => ({ generation, source: 'live', analysisToken: token, radius: 100,
	snapshotExpiresAt: '2026-10-11T03:30:00Z' });
const saved = (generation, analysisId) => ({ generation, source: 'saved', analysisId, title: '서울시청', radius: 100 });

test('snapshot statistics are requested only while the tab is visible', async () => {
	const h = harness();
	h.controller.refreshStatus(true);
	await h.available();
	h.controller.setAnalysis(live(1));

	assert.equal(h.statsCalls().length, 0);
	assert.equal(h.state().stats.phase, 'idle');
	h.controller.show();
	assert.deepEqual(h.statsCalls().map((c) => c.url), ['/api/analysis-snapshots/' + TOKEN + '/statistics']);
	assert.equal(h.state().stats.phase, 'loading');
	await h.answer('/statistics', ok(PARTIAL));

	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.state().stats.view.analyzed, 4);
	assert.equal(h.state().target.expiresAt, '2026-10-11T03:30:00Z');
});

test('saved analyses use the analysis id', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(3, 12));

	assert.deepEqual(h.statsCalls().map((c) => c.url), ['/api/analyses/12/statistics']);
	await h.answer('/statistics', ok(PARTIAL));
	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.state().target.title, '서울시청');
});

test('the same statistics are never requested twice', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(1));
	h.controller.setAnalysis(live(1));
	h.controller.show();
	h.controller.hide();
	h.controller.show();
	assert.equal(h.statsCalls().length, 1);

	await h.answer('/statistics', ok(PARTIAL));
	h.controller.show();
	h.controller.setAnalysis(live(1));
	assert.equal(h.statsCalls().length, 1);
	assert.equal(h.state().requestCount, 1);
});

test('a new analysis cancels the previous request and its late answer is ignored', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(1, 'aaaaaaaa-0000-0000-0000-000000000001'));
	const first = h.statsCalls()[0];
	h.controller.setAnalysis(live(2, 'bbbbbbbb-0000-0000-0000-000000000002'));

	assert.equal(first.signal.aborted, true);
	assert.equal(h.statsCalls().length, 2);
	// The old server answer arrives after the abort: it must not replace the new analysis.
	first.resolve(ok(PARTIAL));
	await flush();
	assert.equal(h.state().stats.phase, 'loading');
	assert.equal(h.state().stats.key, '2:token:bbbbbbbb-0000-0000-0000-000000000002');

	const changed = JSON.parse(JSON.stringify(PARTIAL));
	changed.result.counts.analyzed = 99;
	await h.answer('bbbbbbbb', ok(changed));
	assert.equal(h.state().stats.view.analyzed, 99);
});

test('a late answer that ignores the abort signal is still discarded', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(1, 12));
	h.controller.setAnalysis(saved(2, 13));
	// The first request still answers after the second one started.
	await h.answer('/analyses/12/statistics', ok(PARTIAL));

	assert.equal(h.state().stats.phase, 'loading');
	assert.equal(h.state().stats.view, null);
	assert.equal(h.state().target.analysisId, 13);
	await h.answer('/analyses/13/statistics', fail(503, 'ANALYSIS_SERVICE_BUSY'));
	assert.equal(h.state().stats.error.code, 'ANALYSIS_SERVICE_BUSY');
});

test('a late 410 of the old snapshot request does not overwrite the saved-analysis statistics', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(4));
	h.controller.analysisSaved({ generation: 4, analysisId: 21 });
	await h.answer('/analyses/21/statistics', ok(PARTIAL));
	await h.answer(TOKEN, fail(410, 'SNAPSHOT_EXPIRED'));

	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.state().stats.error, null);
});

test('a late answer for a reset analysis is discarded', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(1));
	h.controller.setAnalysis({ generation: 2, source: null });
	await h.answer('/statistics', ok(PARTIAL));

	assert.equal(h.state().stats.phase, 'empty');
	assert.equal(h.state().stats.view, null);
});

test('reset clears the statistics and cancels the request', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(1));
	const request = h.statsCalls()[0];
	h.controller.setAnalysis({ generation: 2, source: null });

	assert.equal(request.signal.aborted, true);
	assert.equal(h.state().target, null);
	assert.equal(h.state().stats.phase, 'empty');
	assert.equal(h.state().stats.view, null);
});

test('opening a saved analysis again requests fresh statistics', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(1, 12));
	await h.answer('/statistics', ok(PARTIAL));
	h.controller.setAnalysis(saved(5, 12));

	assert.equal(h.statsCalls().length, 2);
	assert.equal(h.state().stats.phase, 'loading');
});

/* ---------- saving ---------- */

test('saving during a snapshot request switches to the analysis id without using the token again', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(4));
	const snapshotRequest = h.statsCalls()[0];
	h.controller.analysisSaved({ generation: 4, analysisId: 21, title: '저장 제목' });

	assert.equal(snapshotRequest.signal.aborted, true);
	assert.deepEqual(h.statsCalls().map((c) => c.url),
		['/api/analysis-snapshots/' + TOKEN + '/statistics', '/api/analyses/21/statistics']);
	// The server has removed the snapshot: an answer to the old request would be 410, and is ignored anyway.
	snapshotRequest.resolve(fail(410, 'SNAPSHOT_EXPIRED'));
	await flush();
	await h.answer('/analyses/21/statistics', ok(PARTIAL));

	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.state().stats.error, null);
	assert.equal(h.state().target.kind, 'saved');
	assert.equal(h.state().target.title, '저장 제목');
	assert.equal(h.state().target.token, null);
	h.controller.show();
	assert.equal(h.calls.filter((c) => c.url.includes(TOKEN)).length, 1);
});

test('saving after the statistics were shown keeps them and never calls the snapshot again', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(4));
	await h.answer('/statistics', ok(PARTIAL));
	h.controller.analysisSaved({ generation: 4, analysisId: 21, title: null });
	h.controller.hide();
	h.controller.show();

	assert.equal(h.statsCalls().length, 1);
	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.state().stats.key, '4:id:21');
});

test('saving before the tab was opened uses the id from the start (no 410)', async () => {
	const h = harness();
	h.controller.refreshStatus(true);
	await h.available();
	h.controller.setAnalysis(live(4));
	h.controller.analysisSaved({ generation: 4, analysisId: 21 });
	h.controller.show();

	assert.deepEqual(h.statsCalls().map((c) => c.url), ['/api/analyses/21/statistics']);
});

test('a save of another analysis is ignored', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(5));
	h.controller.analysisSaved({ generation: 4, analysisId: 21 });

	assert.equal(h.state().target.kind, 'snapshot');
	assert.equal(h.statsCalls().length, 1);
});

/* ---------- service status ---------- */

test('status is checked once and again only after 30 seconds', async () => {
	const h = harness();
	h.controller.refreshStatus(true);
	await h.available();
	h.controller.show();
	h.advance(29_000);
	h.controller.hide();
	h.controller.show();
	assert.equal(h.calls.filter((c) => c.url.endsWith('/spatial-analysis/status')).length, 1);

	h.advance(2_000);
	h.controller.hide();
	h.controller.show();
	assert.equal(h.calls.filter((c) => c.url.endsWith('/spatial-analysis/status')).length, 2);
	assert.equal(h.state().service.state, 'checking');
	// No periodic polling: nothing else is requested by itself.
	await h.available();
	assert.equal(h.calls.length, 2);
});

test('statistics wait for the status check', async () => {
	const h = harness();
	h.controller.setAnalysis(live(1));
	h.controller.show();

	assert.equal(h.state().stats.phase, 'waiting');
	assert.equal(h.statsCalls().length, 0);
	await h.available();
	assert.equal(h.statsCalls().length, 1);
});

for (const [body, serviceState] of [[{ available: false, configured: true }, 'unavailable'],
	[{ available: false, configured: false }, 'not-configured']]) {
	test('python ' + serviceState + ': statistics are not requested until it is available', async () => {
		const h = harness();
		h.controller.setAnalysis(live(1));
		h.controller.show();
		await h.answer('/spatial-analysis/status', ok(body));

		assert.equal(h.state().service.state, serviceState);
		assert.equal(h.state().stats.phase, 'blocked');
		assert.equal(h.statsCalls().length, 0);

		h.controller.refreshStatus(true);  // "다시 확인"
		assert.equal(h.state().stats.phase, 'waiting');
		await h.available();
		assert.equal(h.state().stats.phase, 'loading');
		assert.equal(h.statsCalls().length, 1);
	});
}

test('status check failure (Java unreachable) still lets the request report its own error', async () => {
	const h = harness();
	h.controller.setAnalysis(live(1));
	h.controller.show();
	await h.answer('/spatial-analysis/status', { ok: false, network: true, aborted: false });

	assert.equal(h.state().service.state, 'error');
	await h.answer('/statistics', { ok: false, network: true, aborted: false });
	assert.equal(h.state().stats.phase, 'error');
	assert.equal(h.state().stats.error.code, 'NETWORK');
});

/* ---------- errors ---------- */

for (const [status, code] of [[503, 'ANALYSIS_SERVICE_BUSY'], [504, 'ANALYSIS_SERVICE_TIMEOUT'],
	[413, 'ANALYSIS_TOO_LARGE'], [422, 'ANALYSIS_DATA_UNSUPPORTED'], [502, 'ANALYSIS_SERVICE_ERROR'],
	[502, 'ANALYSIS_SERVICE_BAD_RESPONSE'], [410, 'SNAPSHOT_EXPIRED'], [503, 'DB_UNAVAILABLE'],
	[404, 'ANALYSIS_NOT_FOUND']]) {
	test('error ' + code + ' is shown with its message', async () => {
		const h = harness();
		h.controller.show();
		await h.available();
		h.controller.setAnalysis(saved(1, 12));
		await h.answer('/statistics', fail(status, code));

		assert.equal(h.state().stats.phase, 'error');
		assert.equal(h.state().stats.error.code, code);
		assert.equal(h.state().stats.error.message, api.MESSAGES[code]);
		// An error does not trigger another request by itself.
		h.controller.show();
		assert.equal(h.statsCalls().length, 1);
	});
}

test('retry requests the failed statistics again', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(1, 12));
	await h.answer('/statistics', fail(503, 'ANALYSIS_SERVICE_BUSY'));
	assert.equal(h.state().stats.error.retryable, true);
	h.controller.retry();
	await h.answer('/statistics', ok(PARTIAL));

	assert.equal(h.state().stats.phase, 'done');
	assert.equal(h.statsCalls().length, 2);
});

test('a service-down error rechecks the status and retries when it is back', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(1, 12));
	await h.answer('/statistics', fail(503, 'ANALYSIS_SERVICE_UNAVAILABLE'));

	assert.equal(h.state().service.state, 'checking');
	await h.available();
	assert.equal(h.state().stats.phase, 'loading');
	await h.answer('/statistics', ok(PARTIAL));
	assert.equal(h.state().stats.phase, 'done');
});

test('a 200 answer without the building-stats structure is a bad response', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(saved(1, 12));
	await h.answer('/statistics', ok({ analysisIds: [12], result: { counts: {} } }));

	assert.equal(h.state().stats.error.code, 'ANALYSIS_SERVICE_BAD_RESPONSE');
});

test('a live result without a token is an error, not a request', async () => {
	const h = harness();
	h.controller.show();
	await h.available();
	h.controller.setAnalysis(live(1, null));

	assert.equal(h.statsCalls().length, 0);
	assert.equal(h.state().stats.phase, 'error');
	assert.equal(h.state().stats.error.code, 'INVALID_TOKEN');
});
