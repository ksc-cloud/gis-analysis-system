/*
 * GIS 3D 지도 - 격자 렌더링 벤치마크 (8-6B-1A, 개발용 도구)
 *
 * 앱 화면(http://localhost:8080)에서 VWorld 지도가 준비된 뒤 브라우저 개발자 도구 콘솔에 이 파일 내용을 붙여 넣어
 * 실행한다. 앱 소스에는 포함되지 않으며(static 아님) 배포되지 않는다. 사용법: tools/grid-bench/README.md
 *
 *   gridBench.run()                 기본 측정 (100/300/500/1,000/1,345셀 × A/D × 3회)
 *   gridBench.run({ counts: [100], methods: ['D'], repeats: 1, camera: false })
 *   gridBench.measureClicks()       셀 클릭 반응 시간 (직접 클릭)
 *   gridBench.cancel()              실행 중 취소 (만든 도형은 모두 지움)
 *   gridBench.cleanup()             벤치마크가 만든 도형·관찰자·리스너 정리 (몇 번이고 호출 가능)
 *   copy(gridBench.json())          마지막 결과 JSON을 클립보드로 (DevTools 콘솔 전용 copy 함수)
 *
 * 안전 원칙
 * - 공개 API만 쓴다: window.gisMap, vw.geom.PolygonZ, vw.Collection, vw.Coord, vw.Color, map.removeObject,
 *   map.moveTo, vw.CameraPosition, vw.CoordZ, vw.Direction. VWorld/Cesium 내부 객체는 쓰지 않는다.
 * - 이 도구가 만든 도형만 기록하고 지운다. 분석 도형, 검색 마커, 측정 결과는 건드리지 않으며 map.clear()는 호출하지 않는다.
 * - 동시에 한 번만 실행된다. 끝나거나 취소되거나 오류가 나도 만든 도형, PerformanceObserver, DOM 리스너, 예약된
 *   프레임 콜백을 모두 정리한다.
 * - 결과는 콘솔에만 남긴다. 서버나 외부로 전송하지 않는다.
 * - 브라우저 API로 정확히 잴 수 없는 값은 추정하지 않고 null과 limits에 이유를 남긴다.
 */
(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else if (root) {
		if (root.gridBench && typeof root.gridBench.cleanup === 'function') {
			root.gridBench.cleanup(); // 다시 붙여 넣으면 이전 인스턴스의 도형을 먼저 정리한다.
		}
		root.gridBench = api.createBench(api.browserEnv(root));
		if (root.console) {
			root.console.info('[grid-bench] 준비됨: gridBench.run(), gridBench.measureClicks(), gridBench.cancel(), '
				+ 'gridBench.cleanup(), copy(gridBench.json())');
		}
	}
})(typeof window !== 'undefined' ? window : null, function () {
	'use strict';

	var VERSION = 1;
	var DEFAULT_CENTER = { lon: 126.978, lat: 37.5665 }; // 서울특별시청 (vworld-map.js의 서울 도심 위치)
	var COUNTS = [100, 300, 500, 1000, 1345];
	var METHODS = ['A', 'D'];

	// WGS84 (Java PlanarGeometry, Python app/geo/projection.py와 같은 상수)
	var WGS84_A = 6378137.0;
	var WGS84_F = 1 / 298.257223563;
	var WGS84_E2 = WGS84_F * (2 - WGS84_F);

	// 5단계 채움색 (격자 밀집도 색상표를 흉내 낸 것, 측정에는 영향 없음)
	var PALETTE = [[254, 240, 217, 150], [253, 204, 138, 150], [252, 141, 89, 150], [227, 74, 51, 150],
		[179, 0, 0, 150]];

	var LIMITS = [
		'firstFrameMs는 생성이 끝난 뒤 두 번째 requestAnimationFrame까지의 시간이다. VWorld가 지면 도형을 비동기로 '
			+ '준비하면 실제로 화면에 보이는 시각은 이보다 늦을 수 있고, 공개 API로는 알 수 없다(화면 녹화로 확인).',
		'프레임 간격은 requestAnimationFrame 콜백 간격이다. GPU 처리 시간, 화면 합성 지연은 포함되지 않을 수 있다.',
		'긴 작업은 PerformanceObserver(long-animation-frame 또는 longtask)를 지원하는 브라우저에서만 측정한다.',
		'JS 힙은 Chrome 전용 performance.memory 값이다. 기본 설정에서는 값이 양자화되고 GC를 강제할 수 없어 근삿값이며, '
			+ 'GPU 메모리는 포함되지 않는다(Chrome 작업 관리자에서 따로 확인).',
		'카메라 이동 측정은 map.moveTo 애니메이션 동안의 프레임이다. 사람이 끄는 드래그와는 다를 수 있다. 측정 후 카메라는 '
			+ '시작 위치(중심 상공 1,500m)로 돌아가며 이전 시점을 복원하지는 않는다(공개 API로 현재 시점을 읽지 못함).',
		'클릭 반응은 지도 요소 pointerdown부터 PolygonZ 클릭 콜백 호출까지의 시간이다. 이후 화면 갱신 시간은 포함되지 않는다.',
		'restoreMs는 앱의 restore()와 같이 이 도구가 만든 도형을 지우고 다시 만드는 시간이다. 측정 초기화(map.clear) 경로는 '
			+ '다른 도형까지 지우므로 측정하지 않는다.'
	];

	/* ---------- 좌표와 격자 (순수 함수) ---------- */

	function metersPerDegree(lat) {
		var phi = lat * Math.PI / 180;
		var sin = Math.sin(phi);
		var w = Math.sqrt(1 - WGS84_E2 * sin * sin);
		var n = WGS84_A / w;
		var m = WGS84_A * (1 - WGS84_E2) / (w * w * w);
		return { lon: n * Math.cos(phi) * Math.PI / 180, lat: m * Math.PI / 180 };
	}

	// 셀 중심이 원점에서 reach(셀 단위) 이내인 셀 수
	function cellsWithin(reach) {
		var count = 0;
		for (var row = -reach; row <= reach; row++) {
			for (var col = -reach; col <= reach; col++) {
				if (col * col + row * row <= reach * reach) {
					count++;
				}
			}
		}
		return count;
	}

	function toLonLat(center, x, y, scale) {
		return [center.lon + x / scale.lon, center.lat + y / scale.lat];
	}

	/*
	 * 분석 중심 주변의 정사각형 격자. 셀 (0,0)의 중심이 분석 중심이고(Python grid-density와 같은 배치),
	 * 중심에서 가까운 셀부터 count개를 고른다. 1,345개는 반경 1km 원 안 50m 격자 수와 같다.
	 * inset: 각 변을 줄이는 비율(셀 사이 틈, 지면 도형에 외곽선이 없어 격자선 대신 쓰는 방식)
	 * 반환: [{ id, col, row, ring: [[lon, lat] x 4] (닫는 점 없음), center: [lon, lat], empty: false }]
	 */
	function syntheticCells(count, center, cellSize, inset) {
		var n = Math.max(0, Math.floor(count));
		var size = cellSize > 0 ? cellSize : 50;
		var shrink = inset >= 0 && inset < 0.5 ? inset : 0.02;
		if (!center || !isFinite(center.lon) || !isFinite(center.lat)) {
			throw new Error('center { lon, lat } is required');
		}
		// 가까운 순으로 n개를 고르려면 반지름 reach 원 안의 셀만으로 n개가 되어야 한다. (정사각형 모서리 셀이 원 밖의
		// 더 가까운 셀보다 먼저 뽑히지 않도록 정사각형이 아니라 내접원 기준으로 범위를 키운다)
		var reach = 0;
		while (cellsWithin(reach) < n) {
			reach++;
		}
		var positions = [];
		for (var row = -reach; row <= reach; row++) {
			for (var col = -reach; col <= reach; col++) {
				positions.push({ col: col, row: row, d: col * col + row * row });
			}
		}
		positions.sort(function (a, b) {
			return a.d - b.d || a.row - b.row || a.col - b.col;
		});
		var scale = metersPerDegree(center.lat);
		var half = size / 2 * (1 - shrink);
		return positions.slice(0, n).map(function (p) {
			var cx = p.col * size;
			var cy = p.row * size;
			return {
				id: p.col + ':' + p.row,
				col: p.col,
				row: p.row,
				ring: [toLonLat(center, cx - half, cy - half, scale), toLonLat(center, cx + half, cy - half, scale),
					toLonLat(center, cx + half, cy + half, scale), toLonLat(center, cx - half, cy + half, scale)],
				center: toLonLat(center, cx, cy, scale),
				empty: false
			};
		});
	}

	/*
	 * grid-density 응답(Java 응답 { result } 또는 Python 결과 그대로) → 같은 셀 형식.
	 * 빈 격자 제외 방식(C) 측정용: options.excludeEmpty이면 건물이 없는 셀을 뺀다.
	 */
	function cellsFromGridDensity(body, options) {
		var result = body && body.result ? body.result : body;
		var features = result && result.cells && Array.isArray(result.cells.features) ? result.cells.features : null;
		if (!features) {
			throw new Error('grid-density response with cells.features is required');
		}
		var excludeEmpty = !!(options && options.excludeEmpty);
		var cells = [];
		features.forEach(function (feature) {
			var props = feature && feature.properties ? feature.properties : {};
			var outer = feature && feature.geometry && feature.geometry.coordinates ? feature.geometry.coordinates[0] : null;
			if (!Array.isArray(outer) || outer.length < 4) {
				return;
			}
			var empty = !(props.buildingCount > 0) && !(props.primaryBuildingCount > 0);
			if (excludeEmpty && empty) {
				return;
			}
			cells.push({
				id: String(feature.id), col: props.col, row: props.row,
				ring: outer.slice(0, outer.length - 1).map(function (p) {
					return [p[0], p[1]];
				}),
				center: [props.centerLon, props.centerLat],
				empty: empty
			});
		});
		return cells;
	}

	/* ---------- 통계 (순수 함수) ---------- */

	function round(value, digits) {
		if (value === null || value === undefined || !isFinite(value)) {
			return null;
		}
		var scale = Math.pow(10, digits === undefined ? 1 : digits);
		return Math.round(value * scale) / scale;
	}

	// 최근접 순위(nearest-rank) 백분위수
	function percentile(sorted, p) {
		if (!sorted.length) {
			return null;
		}
		var rank = Math.ceil(p / 100 * sorted.length);
		return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
	}

	function summarize(values) {
		var list = (values || []).filter(function (v) {
			return typeof v === 'number' && isFinite(v);
		});
		if (!list.length) {
			return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
		}
		var sorted = list.slice().sort(function (a, b) {
			return a - b;
		});
		var sum = sorted.reduce(function (a, b) {
			return a + b;
		}, 0);
		return {
			count: sorted.length,
			min: round(sorted[0]),
			max: round(sorted[sorted.length - 1]),
			mean: round(sum / sorted.length),
			p50: round(percentile(sorted, 50)),
			p95: round(percentile(sorted, 95))
		};
	}

	/* rAF 간격 목록 → { frames, p50, p95, max, over50, fps } (간격이 없으면 값은 null) */
	function frameStats(intervals, thresholdMs) {
		var limit = thresholdMs || 50;
		var s = summarize(intervals);
		var over = (intervals || []).filter(function (v) {
			return v > limit;
		}).length;
		return {
			frames: s.count,
			p50: s.p50,
			p95: s.p95,
			max: s.max,
			overThreshold: s.count ? over : null,
			thresholdMs: limit,
			fps: s.mean ? round(1000 / s.mean) : null
		};
	}

	/*
	 * 생성·삭제를 반복한 뒤의 힙 크기 → 증가 경향. 판단은 하지 않고 측정값만 낸다.
	 * slopeBytesPerCycle: 최소제곱 기울기, increasingSteps: 직전보다 커진 횟수
	 */
	function memoryTrend(samples) {
		var list = (samples || []).filter(function (v) {
			return typeof v === 'number' && isFinite(v);
		});
		if (list.length < 2) {
			return { samples: list, slopeBytesPerCycle: null, increasingSteps: null, firstToLastBytes: null };
		}
		var n = list.length;
		var meanX = (n - 1) / 2;
		var meanY = list.reduce(function (a, b) {
			return a + b;
		}, 0) / n;
		var num = 0;
		var den = 0;
		for (var i = 0; i < n; i++) {
			num += (i - meanX) * (list[i] - meanY);
			den += (i - meanX) * (i - meanX);
		}
		var increasing = 0;
		for (var j = 1; j < n; j++) {
			if (list[j] > list[j - 1]) {
				increasing++;
			}
		}
		return {
			samples: list,
			slopeBytesPerCycle: Math.round(num / den),
			increasingSteps: increasing,
			firstToLastBytes: list[n - 1] - list[0]
		};
	}

	/* 실행별 결과 → 셀 수·방식별 요약 (중앙값 중심) */
	function summarizeRuns(runs) {
		var groups = {};
		(runs || []).forEach(function (run) {
			var key = run.cells + ':' + run.method;
			(groups[key] = groups[key] || []).push(run);
		});
		return Object.keys(groups).map(function (key) {
			var list = groups[key];
			var pick = function (fn) {
				return list.map(fn).filter(function (v) {
					return typeof v === 'number';
				});
			};
			var median = function (fn) {
				return summarize(pick(fn)).p50;
			};
			var maxOf = function (fn) {
				return summarize(pick(fn)).max;
			};
			return {
				cells: list[0].cells,
				method: list[0].method,
				repeats: list.length,
				createMsMedian: median(function (r) { return r.create.ms; }),
				longTaskMaxMs: maxOf(function (r) { return r.longTasks ? r.longTasks.maxMs : null; }),
				firstFrameMsMedian: median(function (r) { return r.firstFrameMs; }),
				idleP95Median: median(function (r) { return r.framesIdle.p95; }),
				cameraP95Median: median(function (r) { return r.framesCamera ? r.framesCamera.p95 : null; }),
				cameraOverThresholdMax: maxOf(function (r) { return r.framesCamera ? r.framesCamera.overThreshold : null; }),
				restoreMsMedian: median(function (r) { return r.restoreMs; }),
				deleteMsMedian: median(function (r) { return r.deleteMs; }),
				createErrors: pick(function (r) { return r.create.errors; }).reduce(function (a, b) { return a + b; }, 0)
			};
		});
	}

	/* ---------- 실행 환경 ---------- */

	function environment(env) {
		var nav = env.navigator || {};
		var ua = String(nav.userAgent || '');
		var browser = { name: null, version: null };
		var brands = nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : [];
		var brand = brands.filter(function (b) {
			return !/Not.?A.?Brand|Chromium/i.test(b.brand);
		})[0] || brands.filter(function (b) {
			return /Chromium/i.test(b.brand);
		})[0];
		var patterns = [['Edge', /Edg\/([\d.]+)/], ['Opera', /OPR\/([\d.]+)/], ['Chrome', /Chrome\/([\d.]+)/],
			['Firefox', /Firefox\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/]];
		for (var i = 0; i < patterns.length; i++) {
			var match = ua.match(patterns[i][1]);
			if (match) {
				browser = { name: patterns[i][0], version: match[1] };
				break;
			}
		}
		if (brand && !browser.name) {
			browser = { name: brand.brand, version: brand.version };
		}
		var os = nav.userAgentData && nav.userAgentData.platform ? nav.userAgentData.platform : null;
		if (!os) {
			os = /Windows NT ([\d.]+)/.test(ua) ? 'Windows NT ' + RegExp.$1
				: /Mac OS X ([\d_]+)/.test(ua) ? 'macOS ' + RegExp.$1.replace(/_/g, '.')
					: /Android ([\d.]+)/.test(ua) ? 'Android ' + RegExp.$1
						: /(iPhone|iPad).*OS ([\d_]+)/.test(ua) ? 'iOS ' + RegExp.$2.replace(/_/g, '.')
							: /Linux/.test(ua) ? 'Linux' : null;
		}
		var screen = env.screen || {};
		return {
			browser: browser,
			os: os,
			userAgent: ua || null,
			screen: { width: screen.width || null, height: screen.height || null,
				devicePixelRatio: env.devicePixelRatio || null },
			viewport: { width: env.innerWidth || null, height: env.innerHeight || null },
			hardwareConcurrency: nav.hardwareConcurrency || null,
			deviceMemoryGb: nav.deviceMemory || null,
			buildings3d: env.buildings3d ? env.buildings3d() : null
		};
	}

	/* 브라우저 전역에서 필요한 것만 모은다. (테스트는 같은 모양의 가짜 env를 넘긴다) */
	function browserEnv(win) {
		var perf = win.performance;
		return {
			vw: function () {
				return win.vw;
			},
			map: function () {
				return win.gisMap || null;
			},
			now: function () {
				return perf.now();
			},
			raf: function (cb) {
				return win.requestAnimationFrame(cb);
			},
			cancelRaf: function (id) {
				win.cancelAnimationFrame(id);
			},
			setTimeout: function (fn, ms) {
				return win.setTimeout(fn, ms);
			},
			clearTimeout: function (id) {
				win.clearTimeout(id);
			},
			PerformanceObserver: win.PerformanceObserver || null,
			heap: function () {
				return perf && perf.memory && typeof perf.memory.usedJSHeapSize === 'number' ? perf.memory.usedJSHeapSize : null;
			},
			navigator: win.navigator,
			screen: win.screen,
			devicePixelRatio: win.devicePixelRatio,
			innerWidth: win.innerWidth,
			innerHeight: win.innerHeight,
			mapElement: function () {
				return win.document.getElementById('map');
			},
			mode: function () {
				return win.gisTools && typeof win.gisTools.getMode === 'function' ? win.gisTools.getMode() : null;
			},
			analysisCenter: function () {
				var cur = win.gisAnalysis && win.gisAnalysis.getCurrent ? win.gisAnalysis.getCurrent() : null;
				return cur && cur.center ? cur.center : null;
			},
			buildings3d: function () {
				var input = win.document.querySelector('input[data-layer="facility_build"]');
				return input ? !!input.checked : null;
			},
			console: win.console
		};
	}

	/* ---------- 벤치마크 ---------- */

	function createBench(env) {
		var log = env.console || { info: function () {}, warn: function () {}, table: function () {} };
		var state = {
			running: false,
			cancelRequested: false,
			objects: [],          // 이 도구가 만든 도형 { obj, listener }
			observers: [],        // PerformanceObserver
			domListeners: [],     // [element, type, fn, capture]
			rafIds: [],
			timeoutIds: [],
			waiters: [],          // 기다리는 중인 nextFrame/wait { kind, id, resolve }
			last: null
		};

		function vw() {
			return typeof env.vw === 'function' ? env.vw() : env.vw;
		}

		function map() {
			return typeof env.map === 'function' ? env.map() : env.map;
		}

		function cancelled() {
			return state.cancelRequested;
		}

		/*
		 * 프레임·시간 대기. 취소를 요청하면 기다리지 않고 바로 끝난다. (배경 탭처럼 프레임이 오지 않을 때도
		 * 취소·정리가 멈추지 않게 하려는 것)
		 */
		function pending(kind, schedule) {
			if (cancelled()) {
				return Promise.resolve(env.now());
			}
			return new Promise(function (resolve) {
				var waiter = { kind: kind, id: null, resolve: null };
				waiter.resolve = function (value) {
					state.waiters = state.waiters.filter(function (w) {
						return w !== waiter;
					});
					resolve(value);
				};
				state.waiters.push(waiter);
				waiter.id = schedule(waiter.resolve);
			});
		}

		function nextFrame() {
			return pending('raf', function (done) {
				return env.raf(function (time) {
					done(typeof time === 'number' ? time : env.now());
				});
			});
		}

		function wait(ms) {
			return pending('timeout', function (done) {
				return env.setTimeout(function () {
					done(env.now());
				}, ms);
			});
		}

		/* 기다리는 대기를 모두 취소하고 바로 끝낸다. */
		function releaseWaiters() {
			state.waiters.slice().forEach(function (waiter) {
				try {
					if (waiter.kind === 'raf') {
						env.cancelRaf(waiter.id);
					} else {
						env.clearTimeout(waiter.id);
					}
				} catch (e) {
					// 무시
				}
				waiter.resolve(env.now());
			});
		}

		/* rAF 간격을 계속 기록한다. stop()은 간격 목록을 돌려준다. */
		function startSampler() {
			var intervals = [];
			var last = null;
			var running = true;
			var id = null;
			function tick(time) {
				state.rafIds = state.rafIds.filter(function (x) {
					return x !== id;
				});
				if (!running) {
					return;
				}
				var t = typeof time === 'number' ? time : env.now();
				if (last !== null) {
					intervals.push(t - last);
				}
				last = t;
				try {
					id = env.raf(tick);
					state.rafIds.push(id);
				} catch (e) {
					// 프레임 예약이 실패하면 기록만 멈춘다. (실행 흐름의 nextFrame이 같은 오류로 실패해 정리된다)
					running = false;
					id = null;
				}
			}
			id = env.raf(tick);
			state.rafIds.push(id);
			return {
				stop: function () {
					running = false;
					if (id !== null) {
						env.cancelRaf(id);
						state.rafIds = state.rafIds.filter(function (x) {
							return x !== id;
						});
					}
					return intervals;
				}
			};
		}

		/* 긴 작업 관찰. 지원하지 않으면 null. */
		function startLongTasks() {
			var PO = env.PerformanceObserver;
			if (!PO) {
				return null;
			}
			var types = PO.supportedEntryTypes || [];
			var type = types.indexOf('long-animation-frame') >= 0 ? 'long-animation-frame'
				: (types.indexOf('longtask') >= 0 ? 'longtask' : null);
			if (!type) {
				return null;
			}
			var entries = [];
			var observer;
			try {
				observer = new PO(function (list) {
					list.getEntries().forEach(function (entry) {
						entries.push(entry.duration);
					});
				});
				observer.observe({ type: type, buffered: false });
			} catch (e) {
				return null;
			}
			state.observers.push(observer);
			return {
				stop: function () {
					try {
						if (typeof observer.takeRecords === 'function') {
							observer.takeRecords().forEach(function (entry) {
								entries.push(entry.duration);
							});
						}
						observer.disconnect();
					} catch (e) {
						// 이미 끊긴 관찰자
					}
					state.observers = state.observers.filter(function (o) {
						return o !== observer;
					});
					var s = summarize(entries);
					return { type: type, count: s.count, maxMs: s.max, totalMs: round(entries.reduce(function (a, b) {
						return a + b;
					}, 0)) };
				}
			};
		}

		function heap() {
			try {
				return env.heap ? env.heap() : null;
			} catch (e) {
				return null;
			}
		}

		/* 셀 하나를 만든다. 실패하면 일부 만들어진 도형도 지우고 false. */
		function createCell(cell, index) {
			var g = vw();
			var obj = null;
			try {
				var rgba = PALETTE[index % PALETTE.length];
				obj = new g.geom.PolygonZ(new g.Collection(cell.ring.map(function (p) {
					return new g.Coord(p[0], p[1]);
				})));
				obj.setFillColor(new g.Color(rgba[0], rgba[1], rgba[2], rgba[3]));
				obj.create();
				state.objects.push({ obj: obj, listener: false });
				return true;
			} catch (e) {
				if (obj) {
					safeRemove({ obj: obj, listener: false });
				}
				return false;
			}
		}

		function safeRemove(entry) {
			var ok = true;
			try {
				if (entry.listener && typeof entry.obj.removeEventListener === 'function') {
					entry.obj.removeEventListener();
				}
			} catch (e) {
				ok = false;
			}
			try {
				var m = map();
				if (m && typeof m.removeObject === 'function') {
					m.removeObject(entry.obj);
				}
			} catch (e) {
				ok = false;
			}
			return ok;
		}

		/* 이 도구가 만든 도형만 지운다. 반환: 지우다 오류가 난 수 */
		function removeAll() {
			var failures = 0;
			var list = state.objects;
			state.objects = [];
			list.forEach(function (entry) {
				if (!safeRemove(entry)) {
					failures++;
				}
			});
			return failures;
		}

		/* A: 한 번에 만든다. */
		function createAll(cells) {
			var errors = 0;
			for (var i = 0; i < cells.length; i++) {
				if (!createCell(cells[i], i)) {
					errors++;
				}
			}
			return Promise.resolve({ errors: errors, chunks: 1, maxChunkMs: null });
		}

		/* D: 프레임마다 chunkSize개씩 만든다. 취소하면 멈춘다. */
		function createChunked(cells, chunkSize) {
			var size = chunkSize > 0 ? chunkSize : 100;
			var errors = 0;
			var chunks = 0;
			var maxChunkMs = 0;
			var index = 0;
			function step() {
				if (cancelled() || index >= cells.length) {
					return Promise.resolve({ errors: errors, chunks: chunks, maxChunkMs: round(maxChunkMs) });
				}
				var t0 = env.now();
				var end = Math.min(cells.length, index + size);
				for (; index < end; index++) {
					if (!createCell(cells[index], index)) {
						errors++;
					}
				}
				maxChunkMs = Math.max(maxChunkMs, env.now() - t0);
				chunks++;
				return index >= cells.length ? step() : nextFrame().then(step);
			}
			return step();
		}

		var STRATEGIES = { A: createAll, D: createChunked };

		function cameraPositions(center) {
			var scale = metersPerDegree(center.lat);
			var offsets = [[0, 0, 1500, 0, -45], [400, 300, 900, 90, -35], [-400, 300, 900, 180, -35],
				[0, -400, 1200, 270, -50], [0, 0, 1500, 0, -45]];
			return offsets.map(function (o) {
				var p = toLonLat(center, o[0], o[1], scale);
				return { lon: p[0], lat: p[1], alt: o[2], heading: o[3], tilt: o[4] };
			});
		}

		function moveTo(position) {
			var g = vw();
			var m = map();
			if (!m || typeof m.moveTo !== 'function' || typeof g.CameraPosition !== 'function') {
				return false;
			}
			m.moveTo(new g.CameraPosition(new g.CoordZ(position.lon, position.lat, position.alt),
				new g.Direction(position.heading, position.tilt, 0)));
			return true;
		}

		/* 카메라를 정해진 경로로 움직이며 프레임을 기록한다. 지원하지 않으면 null. */
		function cameraFrames(center, stepMs) {
			var positions = cameraPositions(center);
			if (!moveTo(positions[0])) {
				return Promise.resolve(null);
			}
			var sampler = startSampler();
			var i = 1;
			function next() {
				if (cancelled() || i >= positions.length) {
					return Promise.resolve();
				}
				moveTo(positions[i++]);
				return wait(stepMs).then(next);
			}
			return wait(stepMs).then(next).then(function () {
				return frameStats(sampler.stop());
			});
		}

		function sampleIdle(ms) {
			var sampler = startSampler();
			return wait(ms).then(function () {
				return frameStats(sampler.stop());
			});
		}

		/* 셀 수 × 방식 한 번 측정 */
		function measureOnce(cells, method, repeat, options) {
			var run = { cells: cells.length, method: method, repeat: repeat, chunkSize: method === 'D' ? options.chunkSize : null,
				create: null, longTasks: null, framesDuringCreate: null, firstFrameMs: null, framesIdle: null,
				framesCamera: null, restoreMs: null, deleteMs: null, deleteFailures: null,
				heap: { before: heap(), afterCreate: null, afterDelete: null } };
			var sampler;
			var longTasks;
			var createdAt;
			return nextFrame().then(function () {
				sampler = startSampler();
				longTasks = startLongTasks();
				return nextFrame();
			}).then(function () {
				var t0 = env.now();
				return STRATEGIES[method](cells, options.chunkSize).then(function (info) {
					createdAt = env.now();
					run.create = { ms: round(createdAt - t0), created: state.objects.length, errors: info.errors,
						chunks: info.chunks, maxChunkMs: info.maxChunkMs };
				});
			}).then(function () {
				return nextFrame();
			}).then(function () {
				return nextFrame();
			}).then(function () {
				run.firstFrameMs = round(env.now() - createdAt);
				run.framesDuringCreate = frameStats(sampler.stop());
				run.longTasks = longTasks ? longTasks.stop() : null;
				run.heap.afterCreate = heap();
				if (cancelled()) {
					return null;
				}
				return sampleIdle(options.idleSampleMs);
			}).then(function (idle) {
				run.framesIdle = idle || frameStats([]);
				if (cancelled() || !options.camera) {
					return null;
				}
				return cameraFrames(options.center, options.cameraStepMs);
			}).then(function (camera) {
				run.framesCamera = camera;
				if (cancelled()) {
					return;
				}
				// 복원: 앱의 restore()처럼 이 도구의 도형만 지우고 다시 만든다.
				var t0 = env.now();
				removeAll();
				return createAll(cells).then(function () {
					run.restoreMs = round(env.now() - t0);
				});
			}).then(function () {
				var t0 = env.now();
				var count = state.objects.length;
				run.deleteFailures = removeAll();
				run.deleteMs = count ? round(env.now() - t0) : null;
				return nextFrame();
			}).then(function () {
				run.heap.afterDelete = heap();
				run.cancelled = cancelled(); // 취소되면 일부 항목은 null로 남는다.
				return run;
			});
		}

		function finish(result, status, error) {
			var failures = removeAll();
			result.status = status;
			result.error = error ? String(error && error.message ? error.message : error) : null;
			result.cleanupFailures = failures;
			result.finishedAt = new Date().toISOString();
			result.summary = summarizeRuns(result.runs);
			state.last = result;
			state.running = false;
			state.cancelRequested = false;
			stopAll();
			return result;
		}

		function stopAll() {
			state.observers.forEach(function (o) {
				try {
					o.disconnect();
				} catch (e) {
					// 무시
				}
			});
			state.observers = [];
			state.domListeners.forEach(function (l) {
				try {
					l[0].removeEventListener(l[1], l[2], l[3]);
				} catch (e) {
					// 무시
				}
			});
			state.domListeners = [];
			state.rafIds.forEach(function (id) {
				try {
					env.cancelRaf(id);
				} catch (e) {
					// 무시
				}
			});
			state.rafIds = [];
			state.timeoutIds.forEach(function (id) {
				try {
					env.clearTimeout(id);
				} catch (e) {
					// 무시
				}
			});
			state.timeoutIds = [];
			releaseWaiters();
		}

		function checkReady() {
			var g = vw();
			var m = map();
			if (!g || !g.geom || typeof g.geom.PolygonZ !== 'function' || typeof g.Collection !== 'function'
					|| typeof g.Coord !== 'function' || typeof g.Color !== 'function') {
				return 'VWorld 3D 지도 API(vw.geom.PolygonZ)를 찾을 수 없습니다. 지도가 표시된 뒤 실행하세요.';
			}
			if (!m || typeof m.removeObject !== 'function') {
				return 'window.gisMap이 없습니다. 지도가 표시된 뒤 실행하세요.';
			}
			return null;
		}

		function resolveOptions(options) {
			var o = options || {};
			var center = o.center || (env.analysisCenter ? env.analysisCenter() : null);
			return {
				counts: Array.isArray(o.counts) && o.counts.length ? o.counts.slice() : COUNTS.slice(),
				methods: Array.isArray(o.methods) && o.methods.length ? o.methods.slice() : METHODS.slice(),
				repeats: o.repeats > 0 ? Math.floor(o.repeats) : 3,
				warmup: o.warmup !== false,
				chunkSize: o.chunkSize > 0 ? Math.floor(o.chunkSize) : 100,
				idleSampleMs: o.idleSampleMs >= 0 ? o.idleSampleMs : 2000,
				camera: o.camera !== false,
				cameraStepMs: o.cameraStepMs > 0 ? o.cameraStepMs : 1500,
				memoryCycles: o.memoryCycles >= 0 ? Math.floor(o.memoryCycles) : 5,
				cellSize: o.cellSize > 0 ? o.cellSize : 50,
				inset: o.inset >= 0 ? o.inset : 0.02,
				center: center || DEFAULT_CENTER,
				centerSource: o.center ? 'option' : (center ? 'analysis' : 'default'),
				cells: Array.isArray(o.cells) ? o.cells : null // 실제 grid-density 셀 (cellsFromGridDensity 결과)
			};
		}

		function cellsFor(count, options) {
			return options.cells ? options.cells.slice(0, count)
				: syntheticCells(count, options.center, options.cellSize, options.inset);
		}

		/* 기본 측정. 반환: Promise<결과 JSON 객체> */
		function run(options) {
			if (state.running) {
				return Promise.reject(new Error('ALREADY_RUNNING: 벤치마크가 이미 실행 중입니다. gridBench.cancel()로 취소할 수 있습니다.'));
			}
			var notReady = checkReady();
			if (notReady) {
				return Promise.reject(new Error(notReady));
			}
			var o = resolveOptions(options);
			var unknown = o.methods.filter(function (m) {
				return !STRATEGIES[m];
			});
			if (unknown.length) {
				return Promise.reject(new Error('지원하지 않는 방식: ' + unknown.join(', ') + ' (A, D)'));
			}
			state.running = true;
			state.cancelRequested = false;
			var result = {
				tool: 'grid-bench', version: VERSION, kind: 'render',
				startedAt: new Date().toISOString(), finishedAt: null, status: 'running', error: null,
				environment: environment(env),
				options: { counts: o.counts, methods: o.methods, repeats: o.repeats, warmup: o.warmup, chunkSize: o.chunkSize,
					idleSampleMs: o.idleSampleMs, camera: o.camera, cameraStepMs: o.cameraStepMs,
					memoryCycles: o.memoryCycles, cellSizeMeters: o.cellSize, inset: o.inset, center: o.center,
					centerSource: o.centerSource, cellSource: o.cells ? 'grid-density' : 'synthetic' },
				limits: LIMITS.slice(),
				runs: [],
				memoryTrend: null,
				summary: null
			};
			var plan = [];
			o.counts.forEach(function (count) {
				o.methods.forEach(function (method) {
					for (var r = 1; r <= o.repeats; r++) {
						plan.push({ count: count, method: method, repeat: r });
					}
				});
			});
			function warmup() {
				if (!o.warmup) {
					return Promise.resolve();
				}
				// 첫 실행의 초기화 비용을 결과에서 빼기 위한 예열 (기록하지 않음)
				return createAll(cellsFor(Math.min(50, o.counts[0]), o)).then(function () {
					removeAll();
					return nextFrame();
				});
			}
			function step(i) {
				if (cancelled() || i >= plan.length) {
					return Promise.resolve();
				}
				var p = plan[i];
				log.info('[grid-bench] ' + (i + 1) + '/' + plan.length + ': ' + p.count + '셀, 방식 ' + p.method + ', '
					+ p.repeat + '회차');
				return measureOnce(cellsFor(p.count, o), p.method, p.repeat, o).then(function (runResult) {
					if (runResult) {
						result.runs.push(runResult);
					}
					return step(i + 1);
				});
			}
			function memory() {
				if (cancelled() || o.memoryCycles < 2 || heap() === null) {
					result.memoryTrend = heap() === null
						? { supported: false, reason: 'performance.memory를 지원하지 않는 브라우저' } : null;
					return Promise.resolve();
				}
				var count = Math.max.apply(null, o.counts);
				var cells = cellsFor(count, o);
				var samples = [];
				function cycle(k) {
					if (cancelled() || k >= o.memoryCycles) {
						var trend = memoryTrend(samples);
						trend.supported = true;
						trend.cells = cells.length;
						trend.cycles = samples.length;
						result.memoryTrend = trend;
						return Promise.resolve();
					}
					return createAll(cells).then(function () {
						return nextFrame();
					}).then(function () {
						removeAll();
						return nextFrame();
					}).then(function () {
						samples.push(heap());
						return cycle(k + 1);
					});
				}
				return cycle(0);
			}
			return warmup().then(function () {
				return step(0);
			}).then(memory).then(function () {
				var r = finish(result, cancelled() ? 'cancelled' : 'completed', null);
				printSummary(r);
				return r;
			}, function (error) {
				var r = finish(result, 'failed', error);
				log.warn('[grid-bench] 실패: ' + r.error + ' (만든 도형은 모두 지웠습니다)');
				return r;
			});
		}

		function printSummary(result) {
			log.info('[grid-bench] ' + result.status + ': 실행 ' + result.runs.length + '건. copy(gridBench.json())로 결과를 복사하세요.');
			if (typeof log.table === 'function' && result.summary && result.summary.length) {
				log.table(result.summary);
			}
		}

		/*
		 * 셀 클릭 반응 시간: 셀을 만들고, 사용자가 셀을 클릭할 때마다 지도 요소 pointerdown부터 PolygonZ 클릭 콜백까지
		 * 시간을 잰다. samples개를 모으거나 timeoutMs가 지나거나 취소되면 끝나고 모두 정리한다.
		 * 반경 분석 모드에서는 클릭이 분석 중심점을 바꿀 수 있어 실행하지 않는다.
		 */
		function measureClicks(options) {
			if (state.running) {
				return Promise.reject(new Error('ALREADY_RUNNING: 벤치마크가 이미 실행 중입니다.'));
			}
			var notReady = checkReady();
			if (notReady) {
				return Promise.reject(new Error(notReady));
			}
			if (env.mode && env.mode() === 'radius') {
				return Promise.reject(new Error('반경 분석 모드에서는 셀 클릭이 분석 중심점을 바꿀 수 있습니다. "좌표 조회" 등 다른 모드로 바꾼 뒤 실행하세요.'));
			}
			var o = resolveOptions(options);
			var count = options && options.cells > 0 ? Math.floor(options.cells) : 300;
			var wanted = options && options.samples > 0 ? Math.floor(options.samples) : 10;
			var timeoutMs = options && options.timeoutMs > 0 ? options.timeoutMs : 60000;
			var element = env.mapElement ? env.mapElement() : null;
			state.running = true;
			state.cancelRequested = false;
			var result = { tool: 'grid-bench', version: VERSION, kind: 'click', startedAt: new Date().toISOString(),
				finishedAt: null, status: 'running', error: null, environment: environment(env),
				options: { cells: count, samples: wanted, timeoutMs: timeoutMs, center: o.center, centerSource: o.centerSource,
					mode: env.mode ? env.mode() : null },
				limits: [LIMITS[5]], runs: [], clicks: null, summary: null };
			var latencies = [];
			var lastDown = null;
			return new Promise(function (resolve) {
				var done = false;
				function end(status, error) {
					if (done) {
						return;
					}
					done = true;
					result.clicks = { samplesMs: latencies.map(function (v) { return round(v); }),
						stats: summarize(latencies), pointerSupported: !!element };
					resolve(finish(result, status, error));
				}
				try {
					if (element && typeof element.addEventListener === 'function') {
						var onDown = function () {
							lastDown = env.now();
						};
						element.addEventListener('pointerdown', onDown, true);
						state.domListeners.push([element, 'pointerdown', onDown, true]);
					}
					var cells = cellsFor(count, o);
					var errors = 0;
					cells.forEach(function (cell, i) {
						if (!createCell(cell, i)) {
							errors++;
						}
					});
					state.objects.forEach(function (entry) {
						if (typeof entry.obj.addEventListener === 'function') {
							entry.obj.addEventListener(function () {
								if (lastDown !== null) {
									latencies.push(env.now() - lastDown);
									lastDown = null;
								}
								if (latencies.length >= wanted) {
									end('completed', null);
								}
							});
							entry.listener = true;
						}
					});
					result.created = state.objects.length;
					result.createErrors = errors;
					log.info('[grid-bench] 셀 ' + state.objects.length + '개를 만들었습니다. 셀을 ' + wanted + '번 클릭하세요. '
						+ '(gridBench.cancel()로 중단)');
					var poll = function () {
						if (done) {
							return;
						}
						if (cancelled()) {
							end('cancelled', null);
							return;
						}
						wait(200).then(poll);
					};
					wait(timeoutMs).then(function () {
						end(cancelled() ? 'cancelled' : 'timeout', null);
					});
					poll();
				} catch (e) {
					end('failed', e);
				}
			});
		}

		/* 실행 중이면 취소를 요청한다. 진행 중인 단계가 끝나는 대로 도형을 지우고 결과(status: cancelled)를 낸다. */
		function cancel() {
			if (state.running) {
				state.cancelRequested = true;
				releaseWaiters();
				return true;
			}
			return false;
		}

		/*
		 * 이 도구가 만든 것만 즉시 정리한다. 몇 번이고 호출할 수 있다. 실행 중이면 취소도 함께 요청한다
		 * (실행은 남은 단계를 건너뛰고 결과 status: cancelled로 끝나며, 그때 관찰자·리스너도 정리된다).
		 */
		function cleanup() {
			var running = state.running;
			if (running) {
				state.cancelRequested = true;
			}
			var failures = removeAll();
			if (running) {
				releaseWaiters();
			} else {
				stopAll();
			}
			return { removedFailures: failures, objects: state.objects.length, observers: state.observers.length,
				listeners: state.domListeners.length, frames: state.rafIds.length, timers: state.timeoutIds.length };
		}

		/* 공개 VWorld API 확인 (방식 E 판단용, 읽기만 한다) */
		function probe() {
			var g = vw();
			if (!g) {
				return null;
			}
			var keys = function (o) {
				return o ? Object.keys(o).filter(function (k) {
					return typeof o[k] === 'function';
				}).sort() : [];
			};
			return { geom: keys(g.geom), vw: keys(g),
				note: '목록에 있어도 공개 API인지는 VWorld 공식 문서로 확인해야 한다.' };
		}

		return {
			run: run,
			measureClicks: measureClicks,
			cancel: cancel,
			cleanup: cleanup,
			probe: probe,
			status: function () {
				return { running: state.running, cancelRequested: state.cancelRequested, objects: state.objects.length,
					observers: state.observers.length, listeners: state.domListeners.length };
			},
			lastResult: function () {
				return state.last;
			},
			json: function () {
				return JSON.stringify(state.last, null, 2);
			},
			cellsFromGridDensity: cellsFromGridDensity
		};
	}

	return {
		VERSION: VERSION,
		COUNTS: COUNTS,
		METHODS: METHODS,
		DEFAULT_CENTER: DEFAULT_CENTER,
		LIMITS: LIMITS,
		metersPerDegree: metersPerDegree,
		syntheticCells: syntheticCells,
		cellsFromGridDensity: cellsFromGridDensity,
		summarize: summarize,
		frameStats: frameStats,
		memoryTrend: memoryTrend,
		summarizeRuns: summarizeRuns,
		environment: environment,
		browserEnv: browserEnv,
		createBench: createBench
	};
});
