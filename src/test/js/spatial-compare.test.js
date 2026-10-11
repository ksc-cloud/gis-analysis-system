// node --test "src/test/js/*.test.js"  (Node.js 내장 테스트 러너, npm 패키지 없음)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const JS = path.join(__dirname, '../../main/resources/static/js');
const api = require(path.join(JS, 'spatial-api.js'));
const compare = require(path.join(JS, 'spatial-compare.js'));
// Real compare-analyses responses (Python compare_analyses) in the Java envelope.
const OBSERVATION = require('./fixtures/compare-observation.json');
const CHANGE = require('./fixtures/compare-change.json');
const NOT_COMPARABLE = require('./fixtures/compare-not-comparable.json');

const item = (analysisId, title = '분석 ' + analysisId) => ({ analysisId, title, radiusMeters: 100, complete: true });

/* ---------- comparison URL and %p ---------- */

test('comparison URL and percent points', () => {
	assert.equal(api.comparisonUrl(15, 12), '/api/analyses/15/comparison?with=12&includeUnchanged=false&includeBuildingChanges=true');
	assert.equal(api.comparisonUrl(12, 15, { includeUnchanged: true }, '/ctx/api'),
		'/ctx/api/analyses/12/comparison?with=15&includeUnchanged=true&includeBuildingChanges=true');
	assert.equal(api.comparisonUrl(12, 12), null);
	assert.equal(api.comparisonUrl('1;x', 2), null);
	assert.equal(api.formatPercentPoint(0.0637), '+0.06%p');
	assert.equal(api.formatPercentPoint(-1.5), '-1.50%p');
	assert.equal(api.formatPercentPoint(0), '0.00%p');
	assert.equal(api.formatPercentPoint(null), '-');
	assert.equal(api.describeError({ ok: false, status: 400, body: { error: 'SAME_ANALYSIS' } }).message,
		api.MESSAGES.SAME_ANALYSIS);
});

/* ---------- view ---------- */

test('before and after come from the server order with the selected titles', () => {
	const view = compare.buildCompareView(OBSERVATION, [item(15, '이후 제목'), item(12, '이전 제목')]);

	assert.equal(view.before.analysisId, 12);
	assert.equal(view.before.title, '이전 제목');
	assert.equal(view.after.analysisId, 15);
	assert.equal(view.after.title, '이후 제목');
	assert.equal(view.before.complete, true);
	assert.equal(view.after.complete, false);
	assert.equal(view.before.analyzedAt, OBSERVATION.result.before.source.analyzedAt);
	assert.equal(compare.buildCompareView(OBSERVATION, []).before.title, '분석 #12');
});

test('statistics rows: before, after, signed change, %p and rate', () => {
	const rows = compare.metricRows(OBSERVATION.result.statistics, api);
	const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
	const s = OBSERVATION.result.statistics;

	assert.deepEqual(rows.map((r) => r.key), ['buildingCount', 'unionArea', 'coverageRatio', 'averageArea',
		'averageFloors', 'floorsWithData']);
	assert.equal(byKey.coverageRatio.before, api.formatPercent(s.coverageRatio.before * 100));
	assert.equal(byKey.coverageRatio.delta, api.formatPercentPoint(s.coverageRatio.deltaPercentPoint));
	assert.match(byKey.coverageRatio.delta, /%p$/);
	assert.equal(byKey.coverageRatio.direction, 'down');
	assert.equal(byKey.unionArea.delta, api.signed(s.unionArea.delta, api.formatArea(Math.abs(s.unionArea.delta))));
	for (const row of rows.filter((r) => r.key !== 'coverageRatio')) {
		assert.doesNotMatch(row.delta, /%p/);
	}
	assert.equal(byKey.buildingCount.before, api.formatCount(s.buildingCount.before));
	assert.match(byKey.averageFloors.after, /층$/);
});

test('change rate is "계산 불가" when before is 0 or missing', () => {
	const rows = compare.metricRows({
		buildingCount: { before: 0, after: 3, delta: 3, changeRate: null },
		unionArea: { before: 100, after: 110, delta: 10, changeRate: 0.1 },
		coverageRatio: { before: 0, after: 0.01, delta: 0.01, changeRate: null, deltaPercentPoint: 1 },
		averageArea: { before: null, after: 50, delta: null, changeRate: null },
		averageFloors: { before: 3, after: 2.5, delta: -0.5, changeRate: -0.166667 },
		floorsWithData: { before: 2, after: 2, delta: 0, changeRate: 0 }
	}, api);
	const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

	assert.equal(byKey.buildingCount.rate, '계산 불가');
	assert.equal(byKey.buildingCount.delta, '+3개');
	assert.equal(byKey.buildingCount.direction, 'up');
	assert.equal(byKey.unionArea.rate, '+10.0%');
	assert.equal(byKey.coverageRatio.delta, '+1.00%p');
	assert.equal(byKey.coverageRatio.rate, '계산 불가');
	assert.equal(byKey.averageArea.before, '-');
	assert.equal(byKey.averageArea.delta, '-');
	assert.equal(byKey.averageArea.direction, 'none');
	assert.equal(byKey.averageFloors.delta, '-0.5층');
	assert.equal(byKey.averageFloors.rate, '-16.7%');
	assert.equal(byKey.averageFloors.direction, 'down');
	assert.equal(byKey.floorsWithData.delta, '0개');
	assert.equal(byKey.floorsWithData.direction, 'zero');
});

test('status labels never claim construction or demolition', () => {
	for (const label of Object.values(compare.STATUS_LABELS)) {
		assert.doesNotMatch(label, /신축|철거/);
	}
	assert.equal(compare.STATUS_LABELS.ONLY_IN_BEFORE, '이전 분석에서만 관측');
	assert.equal(compare.STATUS_LABELS.ONLY_IN_AFTER, '이후 분석에서만 관측');
	assert.match(compare.STATUS_LABELS.ADDED, /데이터 기준/);
	assert.match(compare.STATUS_LABELS.REMOVED, /데이터 기준/);
});

test('partial comparisons get the observation warning and "only in" summary labels', () => {
	const view = compare.buildCompareView(OBSERVATION, []);
	const box = compare.basisBox(view);
	const summary = compare.summaryItems(view.summary, view.basis, api);

	assert.equal(view.basis, 'OBSERVATION_DIFFERENCE');
	assert.equal(box.warning, true);
	assert.match(box.text, /한쪽 이상의 분석이 부분 조회 결과입니다\. 실제 건물의 신축이나 철거로 단정할 수 없습니다\./);
	assert.deepEqual(summary.slice(0, 2).map((s) => s.label), ['이후 분석에서만 관측', '이전 분석에서만 관측']);
	assert.equal(summary[0].value, '2건');
	// The OBSERVATION_DIFFERENCE warning is shown in the box, not repeated in the list.
	assert.ok(view.warnings.every((w) => w.code !== 'OBSERVATION_DIFFERENCE'));
});

test('complete comparisons say additions are data changes, not construction', () => {
	const view = compare.buildCompareView(CHANGE, []);
	const box = compare.basisBox(view);
	const summary = compare.summaryItems(view.summary, view.basis, api);

	assert.equal(box.warning, false);
	assert.match(box.text, /실제 신축·철거를 확인한 것이 아닙니다/);
	assert.deepEqual(summary.map((s) => s.key), ['added', 'removed', 'modified', 'unchanged', 'uncomparable',
		'lowConfidence', 'candidates']);
	assert.equal(summary[1].value, '15건');
	assert.equal(summary[4].value, '이전 2건 · 이후 32건');
});

test('not comparable: reasons in Korean, no statistics', () => {
	const view = compare.buildCompareView(NOT_COMPARABLE, []);

	assert.equal(view.comparable, false);
	assert.deepEqual(view.reasons.map((r) => r.code), ['CENTER_DIFFERENT', 'RADIUS_DIFFERENT']);
	assert.match(view.reasons[0].label, /중심점이 다릅니다/);
	assert.match(view.reasons[1].label, /반경이 다릅니다/);
	assert.ok(view.reasons[0].detail.length > 0);
	assert.equal(compare.basisBox(view).title, '비교할 수 없는 분석입니다');
	assert.deepEqual(view.changes, []);
});

test('building rows: id, status, area, floors, IoU, confidence and basis', () => {
	const changes = OBSERVATION.result.buildings.changes;
	const modified = compare.changeItem(changes.find((c) => c.id === 'bd:1'), api);
	const onlyAfter = compare.changeItem(changes.find((c) => c.id === 'bd:3'), api);
	const repaired = compare.changeItem(changes.find((c) => c.id === 'bd:5'), api);

	assert.equal(modified.statusLabel, '변경');
	assert.equal(modified.area, '100.0 m² → 144.0 m² (+44.0 m², +44.0%)');
	assert.equal(modified.floors, '3층 → 5층 (+2층)');
	assert.equal(modified.iou, '0.694');
	assert.equal(modified.confidence, '높음');
	assert.equal(modified.basis, '건물관리번호 일치');
	assert.deepEqual(modified.changes, ['도형 변경', '층수 변경']);
	assert.equal(onlyAfter.statusLabel, '이후 분석에서만 관측');
	assert.equal(onlyAfter.area, '100.0 m² (이후 분석)');
	assert.equal(onlyAfter.iou, '-');
	assert.equal(onlyAfter.confidence, '-');
	assert.equal(repaired.confidence, '낮음');

	const uncomparable = OBSERVATION.result.buildings.uncomparable.map((u) => compare.uncomparableItem(u, api));
	assert.deepEqual(uncomparable.map((u) => u.category), ['신뢰도 낮음', '비교 불가', '비교 불가', '비교 불가']);
	assert.match(uncomparable[1].reason, /IoU 0\.5 미만/);
	assert.equal(uncomparable[1].side, '양쪽');
	assert.match(uncomparable[2].reason, /row:/);

	const candidate = compare.candidateItem(OBSERVATION.result.buildings.possibleSameBuilding[1], api);
	assert.deepEqual(candidate, { beforeId: 'bd:9', afterId: 'bd:10', iou: '0.961', status: '후보' });
});

test('responses without the comparison structure are rejected', () => {
	for (const body of [null, {}, { result: {} }, { result: { ...OBSERVATION.result, comparable: 'yes' } },
		{ result: { ...OBSERVATION.result, comparisonBasis: 'GUESS' } },
		{ result: { ...OBSERVATION.result, statistics: null } }, { result: { ...OBSERVATION.result, before: null } }]) {
		assert.equal(compare.buildCompareView(body, []), null);
	}
});

/* ---------- selection ---------- */

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

function harness(options = {}) {
	const calls = [];
	const selections = [];
	let statusRefreshes = 0;
	const controller = compare.createController({
		api,
		base: '/api',
		fetchJson(url, signal) {
			return new Promise((resolve) => {
				const call = { url, signal, resolve, answered: false };
				calls.push(call);
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
		online: () => true,
		render: () => {},
		onSelectionChange: (selection) => selections.push(selection.map((s) => s.analysisId)),
		refreshStatus: () => {
			statusRefreshes++;
		}
	});
	async function answer(fragment, res) {
		const call = calls.find((c) => !c.answered && c.url.includes(fragment));
		assert.ok(call, 'no pending request for ' + fragment);
		call.answered = true;
		call.resolve(res);
		await flush();
	}
	return { controller, calls, selections, answer, state: () => controller.getState(),
		statusRefreshes: () => statusRefreshes };
}

const ok = (body) => ({ ok: true, status: 200, body });

test('at most two analyses, no duplicates, toggling removes', () => {
	const h = harness();
	assert.equal(h.controller.toggle(item(12)), true);
	assert.equal(h.controller.toggle(item(15)), true);
	assert.equal(h.controller.canSelect(20), false);
	assert.equal(h.controller.toggle(item(20)), false);
	assert.deepEqual(h.state().selection.map((s) => s.analysisId), [12, 15]);
	assert.equal(h.controller.canSelect(12), true);  // a selected one can always be unselected

	assert.equal(h.controller.toggle(item(12)), true);  // the same id again = unselect, never a duplicate
	assert.deepEqual(h.state().selection.map((s) => s.analysisId), [15]);
	assert.equal(h.controller.toggle(item(20)), true);
	assert.deepEqual(h.selections, [[12], [12, 15], [15], [15, 20]]);
	for (const invalid of [null, {}, { analysisId: 0 }, { analysisId: '3' }, { analysisId: 1.5 }]) {
		assert.equal(h.controller.toggle(invalid), false);
	}
	h.controller.clearSelection();
	assert.deepEqual(h.state().selection, []);
});

test('the selection only depends on ids, so it survives history page changes', () => {
	const h = harness();
	h.controller.toggle(item(12, '1페이지 항목'));
	// The history list is reloaded for page 2: nothing in the selection changes.
	assert.equal(h.controller.isSelected(12), true);
	h.controller.toggle(item(31, '2페이지 항목'));
	assert.deepEqual(h.state().selection.map((s) => s.title), ['1페이지 항목', '2페이지 항목']);
	assert.equal(h.controller.canRun(), true);
});

test('a deleted history entry leaves the selection and its comparison', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	await h.answer('/comparison', ok(OBSERVATION));
	assert.equal(h.state().request.phase, 'done');

	h.controller.removeDeleted(99);  // not involved: nothing happens
	assert.equal(h.state().request.phase, 'done');
	h.controller.removeDeleted(15);
	assert.deepEqual(h.state().selection.map((s) => s.analysisId), [12]);
	assert.equal(h.state().request.phase, 'empty');
	assert.equal(h.state().request.view, null);
	assert.equal(h.state().request.notice, 'deleted');
});

/* ---------- requests ---------- */

test('run calls the comparison API once for the selected pair', async () => {
	const h = harness();
	h.controller.toggle(item(15));
	assert.equal(h.controller.run(), false);  // one analysis is not enough
	h.controller.toggle(item(12));
	assert.equal(h.controller.run(), true);
	assert.equal(h.controller.run(), false);  // same comparison already loading
	assert.deepEqual(h.calls.map((c) => c.url),
		['/api/analyses/15/comparison?with=12&includeUnchanged=false&includeBuildingChanges=true']);

	await h.answer('/comparison', ok(OBSERVATION));
	assert.equal(h.controller.run(), false);  // already shown
	assert.equal(h.calls.length, 1);
	assert.equal(h.state().requestCount, 1);
	assert.equal(h.state().request.view.before.analysisId, 12);
});

test('changing the pair clears the previous result and aborts the request', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	const first = h.calls[0];
	h.controller.toggle(item(15));

	assert.equal(first.signal.aborted, true);
	assert.equal(h.state().request.phase, 'empty');
	assert.equal(h.state().request.notice, 'selection-changed');
	h.controller.toggle(item(20));
	h.controller.run();
	assert.match(h.calls[1].url, /\/analyses\/12\/comparison\?with=20/);
});

test('a late answer for a replaced comparison is discarded', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	h.controller.toggle(item(15));
	h.controller.toggle(item(20));
	h.controller.run();
	await h.answer('with=15', ok(OBSERVATION));

	assert.equal(h.state().request.phase, 'loading');
	assert.deepEqual(h.state().request.ids, [12, 20]);
	await h.answer('with=20', ok(CHANGE));
	assert.equal(h.state().request.view.basis, 'CHANGE');
});

test('a late answer after the selection was cleared is discarded', async () => {
	const h = harness({ ignoreAbort: true });
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	h.controller.clearSelection();
	await h.answer('/comparison', ok(OBSERVATION));

	assert.equal(h.state().request.phase, 'empty');
	assert.equal(h.state().request.view, null);
});

test('the unchanged-buildings option asks again with the option', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	await h.answer('/comparison', ok(OBSERVATION));
	h.controller.setIncludeUnchanged(true);

	assert.equal(h.calls.length, 2);
	assert.match(h.calls[1].url, /includeUnchanged=true/);
	await h.answer('includeUnchanged=true', ok(OBSERVATION));
	assert.equal(h.state().request.phase, 'done');
	assert.equal(h.state().request.key, '12:15:all');
});

test('python not available: no request until the service is back', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.setService('unavailable');

	assert.equal(h.controller.canRun(), false);
	assert.equal(h.controller.run(), false);
	assert.equal(h.state().request.phase, 'blocked');
	assert.equal(h.calls.length, 0);
	h.controller.setService('checking');
	assert.equal(h.calls.length, 0);
	h.controller.setService('available');  // the postponed comparison goes ahead
	assert.equal(h.calls.length, 1);
	assert.equal(h.state().request.phase, 'loading');
});

test('not-configured blocks the comparison too', () => {
	const h = harness();
	h.controller.setService('not-configured');
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	assert.equal(h.state().request.phase, 'blocked');
	assert.equal(h.calls.length, 0);
});

for (const [status, code] of [[503, 'ANALYSIS_SERVICE_UNAVAILABLE'], [503, 'ANALYSIS_SERVICE_BUSY'],
	[504, 'ANALYSIS_SERVICE_TIMEOUT'], [413, 'ANALYSIS_TOO_LARGE'], [422, 'ANALYSIS_DATA_UNSUPPORTED'],
	[404, 'ANALYSIS_NOT_FOUND'], [503, 'DB_UNAVAILABLE'], [400, 'SAME_ANALYSIS']]) {
	test('comparison error ' + code, async () => {
		const h = harness();
		h.controller.toggle(item(12));
		h.controller.toggle(item(15));
		h.controller.run();
		await h.answer('/comparison', { ok: false, status, body: { error: code, message: 'server text' } });

		assert.equal(h.state().request.phase, 'error');
		assert.equal(h.state().request.error.code, code);
		assert.equal(h.state().request.error.message, api.MESSAGES[code]);
		assert.equal(h.statusRefreshes(), code === 'ANALYSIS_SERVICE_UNAVAILABLE' ? 1 : 0);
		// Selection stays; the comparison is only retried on request.
		assert.equal(h.state().selection.length, 2);
		assert.equal(h.calls.length, 1);
	});
}

test('retry asks again after an error', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	await h.answer('/comparison', { ok: false, status: 504, body: { error: 'ANALYSIS_SERVICE_TIMEOUT' } });
	h.controller.retry();
	await h.answer('/comparison', ok(CHANGE));

	assert.equal(h.state().request.phase, 'done');
	assert.equal(h.calls.length, 2);
});

test('a 200 answer that is not a comparison is a bad response', async () => {
	const h = harness();
	h.controller.toggle(item(12));
	h.controller.toggle(item(15));
	h.controller.run();
	await h.answer('/comparison', ok({ result: { comparable: true } }));

	assert.equal(h.state().request.error.code, 'ANALYSIS_SERVICE_BAD_RESPONSE');
});

test('comparison keys ignore the order of the ids', () => {
	assert.equal(compare.compareKey([15, 12], false), compare.compareKey([12, 15], false));
	assert.notEqual(compare.compareKey([12, 15], false), compare.compareKey([12, 15], true));
});
