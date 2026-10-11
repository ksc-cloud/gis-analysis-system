/*
 * GIS 3D 지도 - 격자 밀집도 도형 (8-6B-2b, VWorld 공개 도형 API)
 *
 * grid-density 응답의 cells(GeoJSON FeatureCollection, WGS84 경위도 Polygon)를 셀마다 vw.geom.PolygonZ로 그린다.
 * 사용하는 공개 API (map-analysis-renderer.js와 같음):
 *   vw.geom.PolygonZ(vw.Collection<vw.Coord>), setFillColor(vw.Color), create(), addEventListener(fn)
 *   (create() 이후에 등록해야 클릭이 연결된다), removeEventListener(), vw.Map.removeObject(obj)
 * - map.clear()는 호출하지 않는다. 측정 초기화(map.clear)로 지워진 뒤에는 보관한 셀 정의로 restore()한다.
 * - 셀 정의(cells)는 원시 숫자·문자열만 보관하고, VWorld 객체(PolygonZ, Collection, Coord) 참조는 그린 동안만
 *   objects 목록에 두었다가 지울 때 버린다. 색상(vw.Color)은 종류별로 하나씩만 만들어 공유한다.
 * - 그리기는 requestAnimationFrame으로 프레임당 최대 100개씩 나누어 한다(성능 측정 8-6B-1의 D 방식).
 *   새로 그리거나 취소하면 이전 작업은 더 이상 셀을 만들지 않고(작업 번호 확인), 이미 만든 도형은 모두 지운다.
 * - 화면에 그리는 셀은 최대 1,345개(반경 1km·50m 격자, 성능 측정 범위)다. 넘으면 중심에서 가까운 셀부터 그리고
 *   몇 개를 뺐는지 알려 준다.
 * - 공개 여부가 확인되지 않은 show/hide 같은 메서드는 쓰지 않는다.
 * - 셀 변환·색상 분류는 DOM과 VWorld 없이 동작해 node --test로 검사한다.
 */
(function (factory) {
	'use strict';
	var grid = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = grid;
	} else {
		grid.install(window, document);
	}
})(function () {
	'use strict';

	var MAX_CELLS = 1345;
	var CHUNK_SIZE = 100;
	var INSET = 0.02;

	// coverageRatio(0~1) 단계: 0~5%, 5~15%, 15~30%, 30~50%, 50% 초과
	var COVERAGE_LIMITS = [0.05, 0.15, 0.30, 0.50];
	var COVERAGE_LABELS = ['0~5%', '5~15%', '15~30%', '30~50%', '50% 초과'];

	// 단계별 채움색 (밝은 노랑 → 진한 빨강). 경계 셀은 불투명도를 낮추고, 원 안 면적이 작은 셀은 회색으로 따로 칠한다.
	var COVERAGE_COLORS = [[255, 237, 160, 150], [254, 196, 79, 160], [253, 141, 60, 170], [227, 74, 51, 180],
		[179, 0, 0, 190]];
	var BOUNDARY_ALPHA = 0.6;
	var SMALL_BOUNDARY_COLOR = [148, 163, 184, 110];

	/* ---------- 셀 변환 (순수 함수) ---------- */

	function isFiniteNumber(value) {
		return typeof value === 'number' && isFinite(value);
	}

	function isCount(value) {
		return isFiniteNumber(value) && value >= 0 && Math.floor(value) === value;
	}

	/* coverageRatio → 0~4단계, 숫자가 아니거나 범위 밖이면 null */
	function coverageClass(ratio) {
		if (!isFiniteNumber(ratio) || ratio < 0 || ratio > 1.000001) {
			return null;
		}
		for (var i = 0; i < COVERAGE_LIMITS.length; i++) {
			if (ratio <= COVERAGE_LIMITS[i]) {
				return i;
			}
		}
		return COVERAGE_LIMITS.length;
	}

	/* 건물이 하나도 없는 셀 (셀 안 면적이 있는 건물도, 대표 건물도 없음) */
	function isEmptyCell(properties) {
		return !(properties.buildingCount > 0) && !(properties.primaryBuildingCount > 0);
	}

	function validPosition(p) {
		return Array.isArray(p) && p.length >= 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1])
			&& p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
	}

	/* 바깥 링 → 닫는 점을 뺀 [[lon, lat], ...] (3점 이상), 올바르지 않으면 null */
	function outerRing(geometry) {
		if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
			return null;
		}
		var ring = geometry.coordinates[0];
		if (!Array.isArray(ring) || !ring.every(validPosition)) {
			return null;
		}
		var points = ring.map(function (p) {
			return [p[0], p[1]];
		});
		var first = points[0];
		var last = points[points.length - 1];
		if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) {
			points.pop();
		}
		return points.length >= 3 ? points : null;
	}

	/* 셀 중심 쪽으로 inset 비율만큼 줄인 링 (지면 도형은 외곽선이 없어 셀 사이 틈으로 격자선을 표현한다) */
	function insetRing(points, center, inset) {
		var k = 1 - inset;
		return points.map(function (p) {
			return [center[0] + (p[0] - center[0]) * k, center[1] + (p[1] - center[1]) * k];
		});
	}

	function ringCenter(points) {
		var lon = 0;
		var lat = 0;
		points.forEach(function (p) {
			lon += p[0];
			lat += p[1];
		});
		return [lon / points.length, lat / points.length];
	}

	/* 셀 하나 → 원시 데이터 셀 정의, 필수 값이 없거나 이상하면 null */
	function toCell(feature, inset) {
		if (!feature || typeof feature !== 'object' || feature.type !== 'Feature') {
			return null;
		}
		var props = feature.properties;
		if (!props || typeof props !== 'object' || !isCount(props.buildingCount) || !isCount(props.primaryBuildingCount)
				|| coverageClass(props.coverageRatio) === null) {
			return null;
		}
		var points = outerRing(feature.geometry);
		if (!points) {
			return null;
		}
		var center = isFiniteNumber(props.centerLon) && isFiniteNumber(props.centerLat)
			? [props.centerLon, props.centerLat] : ringCenter(points);
		var id = feature.id;
		return {
			id: typeof id === 'string' || isFiniteNumber(id) ? String(id) : (props.col + ':' + props.row),
			col: isFiniteNumber(props.col) ? props.col : null,
			row: isFiniteNumber(props.row) ? props.row : null,
			ring: insetRing(points, center, inset),
			center: center,
			coverageRatio: props.coverageRatio,
			coverageClass: coverageClass(props.coverageRatio),
			buildingCount: props.buildingCount,
			primaryBuildingCount: props.primaryBuildingCount,
			boundary: props.boundary === true,
			smallBoundary: props.smallBoundary === true,
			empty: isEmptyCell(props)
		};
	}

	function featureCollection(source) {
		var candidates = [source, source && source.cells, source && source.result && source.result.cells];
		for (var i = 0; i < candidates.length; i++) {
			var c = candidates[i];
			if (c && c.type === 'FeatureCollection' && Array.isArray(c.features)) {
				return c;
			}
		}
		return null;
	}

	/*
	 * grid-density 응답(Java 응답, result, cells 중 무엇이든) → 그릴 셀 목록과 개수 정보
	 * options: { excludeEmpty: true(기본), maxCells: 1345(기본), inset: 0.02(기본) }
	 * 반환: { cells, total, invalid, emptyExcluded, available, shown, truncated, maxCells }
	 *   total: 응답의 셀 수, invalid: 좌표나 필수 속성이 올바르지 않아 뺀 수, emptyExcluded: 빈 격자로 뺀 수,
	 *   available: 그릴 수 있는 셀 수, shown: 실제로 그릴 셀 수(상한 적용), truncated: 상한 때문에 뺀 수
	 * FeatureCollection이 아니면 TypeError
	 */
	function prepareCells(source, options) {
		var fc = featureCollection(source);
		if (!fc) {
			throw new TypeError('grid-density cells(FeatureCollection)가 필요합니다.');
		}
		var excludeEmpty = !(options && options.excludeEmpty === false);
		var maxCells = options && options.maxCells > 0 ? Math.floor(options.maxCells) : MAX_CELLS;
		var inset = options && options.inset >= 0 && options.inset < 0.5 ? options.inset : INSET;
		var invalid = 0;
		var emptyExcluded = 0;
		var cells = [];
		fc.features.forEach(function (feature) {
			var cell = toCell(feature, inset);
			if (!cell) {
				invalid++;
			} else if (excludeEmpty && cell.empty) {
				emptyExcluded++;
			} else {
				cells.push(cell);
			}
		});
		var available = cells.length;
		if (available > maxCells) {
			// 분석 중심(셀 0,0)에서 가까운 셀부터 남긴다. 위치를 모르는 셀은 맨 뒤로.
			cells = cells.map(function (cell, index) {
				var d = cell.col !== null && cell.row !== null ? cell.col * cell.col + cell.row * cell.row : Infinity;
				return { cell: cell, d: d, index: index };
			}).sort(function (a, b) {
				return a.d - b.d || a.index - b.index;
			}).slice(0, maxCells).map(function (entry) {
				return entry.cell;
			});
		}
		return {
			cells: cells,
			total: fc.features.length,
			invalid: invalid,
			emptyExcluded: emptyExcluded,
			available: available,
			shown: cells.length,
			truncated: available - cells.length,
			maxCells: maxCells
		};
	}

	/* 셀 → 채움색 { key, rgba } (key가 같으면 vw.Color를 공유한다) */
	function cellStyle(cell) {
		if (cell.smallBoundary) {
			return { key: 'small', rgba: SMALL_BOUNDARY_COLOR.slice() };
		}
		var base = COVERAGE_COLORS[cell.coverageClass] || COVERAGE_COLORS[0];
		if (cell.boundary) {
			return { key: 'c' + cell.coverageClass + 'b',
				rgba: [base[0], base[1], base[2], Math.round(base[3] * BOUNDARY_ALPHA)] };
		}
		return { key: 'c' + cell.coverageClass, rgba: base.slice() };
	}

	/* 범례: [{ label, rgba }] + 경계·작은 경계 셀 */
	function legend() {
		var items = COVERAGE_LABELS.map(function (label, i) {
			return { key: 'c' + i, label: '셀 점유율 ' + label, rgba: COVERAGE_COLORS[i].slice() };
		});
		items.push({ key: 'boundary', label: '반경 경계에 걸친 셀(옅은 색)', rgba: null });
		items.push({ key: 'small', label: '원 안 면적이 25% 미만인 경계 셀', rgba: SMALL_BOUNDARY_COLOR.slice() });
		return items;
	}

	/* ---------- 도형 (VWorld) ---------- */

	/*
	 * env: { vw(), raf(cb), cancelRaf(id), console }
	 * 지도는 setMap으로 받는다. 한 번에 하나의 그리기 작업만 진행한다.
	 */
	function createRenderer(env) {
		var log = env.console || { warn: function () {} };
		var state = {
			map: null,
			cells: [],          // 셀 정의 (원시 데이터만)
			objects: [],        // 지금 지도에 있는 도형 { obj, cellId, listener }
			colors: {},         // 종류별 vw.Color
			job: null,          // 진행 중인 작업 { id, index, rafId, resolve, created, errors }
			jobSeq: 0,
			pickHandler: null,
			stats: { created: 0, removed: 0, createErrors: 0, removeErrors: 0 }
		};

		function vw() {
			return typeof env.vw === 'function' ? env.vw() : env.vw;
		}

		function isSupported() {
			var g = vw();
			return !!(g && g.geom && typeof g.geom.PolygonZ === 'function' && typeof g.Collection === 'function'
				&& typeof g.Coord === 'function' && typeof g.Color === 'function'
				&& state.map && typeof state.map.removeObject === 'function');
		}

		function color(style) {
			var g = vw();
			if (!state.colors[style.key]) {
				state.colors[style.key] = new g.Color(style.rgba[0], style.rgba[1], style.rgba[2], style.rgba[3]);
			}
			return state.colors[style.key];
		}

		function removeEntry(entry) {
			var ok = true;
			try {
				if (entry.listener && typeof entry.obj.removeEventListener === 'function') {
					entry.obj.removeEventListener();
				}
			} catch (e) {
				ok = false; // 이미 엔진에서 지워진 도형일 수 있다.
			}
			try {
				if (state.map && typeof state.map.removeObject === 'function') {
					state.map.removeObject(entry.obj);
				}
			} catch (e) {
				ok = false;
			}
			entry.obj = null;
			entry.listener = false;
			if (ok) {
				state.stats.removed++;
			} else {
				state.stats.removeErrors++;
			}
		}

		/* 이 renderer가 만든 도형만 모두 지운다. (map.clear()는 쓰지 않는다) */
		function removeObjects() {
			var list = state.objects;
			state.objects = [];
			list.forEach(removeEntry);
			return list.length;
		}

		function build(cell) {
			var g = vw();
			var obj = null;
			try {
				obj = new g.geom.PolygonZ(new g.Collection(cell.ring.map(function (p) {
					return new g.Coord(p[0], p[1]);
				})));
				obj.setFillColor(color(cellStyle(cell)));
				obj.create();
			} catch (e) {
				if (obj) {
					removeEntry({ obj: obj, listener: false });
				}
				state.stats.createErrors++;
				return false;
			}
			var entry = { obj: obj, cellId: cell.id, listener: false };
			if (typeof obj.addEventListener === 'function') {
				var cellId = cell.id;
				obj.addEventListener(function () {
					if (state.pickHandler) {
						state.pickHandler(cellId);
					}
				});
				entry.listener = true;
			}
			state.objects.push(entry);
			state.stats.created++;
			return true;
		}

		function finishJob(job, status) {
			if (state.job === job) {
				state.job = null;
			}
			job.done = true;
			job.resolve({ status: status, created: job.created, errors: job.errors, total: job.cells.length });
		}

		/* 진행 중인 작업을 멈춘다. 이미 예약된 프레임은 취소하고, 늦게 오더라도 작업 번호로 무시한다. */
		function stopJob() {
			var job = state.job;
			if (!job) {
				return;
			}
			state.job = null;
			if (job.rafId !== null) {
				try {
					env.cancelRaf(job.rafId);
				} catch (e) {
					// 무시
				}
				job.rafId = null;
			}
			finishJob(job, 'cancelled');
		}

		function schedule(job, onProgress) {
			try {
				job.rafId = env.raf(frame);
			} catch (e) {
				// 프레임을 예약하지 못하면 그 작업은 실패로 끝낸다. (만든 도형은 그대로 두고 호출한 쪽이 clear()한다)
				log.warn('[GIS 3D 지도] 격자 그리기 예약 실패', e);
				job.rafId = null;
				finishJob(job, 'failed');
			}
			function frame() {
				job.rafId = null;
				if (state.job !== job || job.done) {
					return; // 취소되었거나 더 새 작업으로 바뀐 작업
				}
				var end = Math.min(job.cells.length, job.index + job.chunkSize);
				for (; job.index < end; job.index++) {
					if (build(job.cells[job.index])) {
						job.created++;
					} else {
						job.errors++;
					}
				}
				if (onProgress) {
					try {
						onProgress({ created: job.created, errors: job.errors, total: job.cells.length });
					} catch (e) {
						log.warn('[GIS 3D 지도] 격자 진행 알림 오류', e);
					}
				}
				if (job.index >= job.cells.length) {
					finishJob(job, 'done');
				} else {
					schedule(job, onProgress);
				}
			}
		}

		function start(onProgress, chunkSize) {
			var cells = state.cells;
			return new Promise(function (resolve) {
				var job = { id: ++state.jobSeq, cells: cells, index: 0, rafId: null, resolve: resolve, created: 0, errors: 0,
					done: false, chunkSize: chunkSize > 0 ? Math.min(Math.floor(chunkSize), CHUNK_SIZE) : CHUNK_SIZE };
				if (!cells.length) {
					resolve({ status: 'done', created: 0, errors: 0, total: 0 });
					return;
				}
				state.job = job;
				schedule(job, onProgress);
			});
		}

		/*
		 * 셀을 그린다. 이전 작업은 취소하고, 이전 도형은 모두 지운 뒤 시작한다.
		 * cells: prepareCells(...).cells
		 * options: { onProgress({ created, errors, total }), chunkSize(최대 100) }
		 * 반환: Promise<{ status: 'done' | 'cancelled' | 'failed' | 'unsupported', created, errors, total }>
		 */
		function render(cells, options) {
			stopJob();
			removeObjects();
			// 원시 값만 복사해 보관한다. (호출한 쪽 배열이나 응답 객체를 붙잡지 않는다)
			state.cells = (Array.isArray(cells) ? cells : []).slice(0, MAX_CELLS).map(copyCell);
			if (!isSupported()) {
				return Promise.resolve({ status: 'unsupported', created: 0, errors: 0, total: state.cells.length });
			}
			return start(options && options.onProgress, options && options.chunkSize);
		}

		/*
		 * 측정 초기화(map.clear()) 뒤 보관한 셀 정의로 다시 그린다. 엔진에서 이미 지워진 도형은 목록에서만 버린다.
		 * 그릴 셀이 없으면 바로 끝난다.
		 */
		function restore(options) {
			stopJob();
			removeObjects();
			if (!isSupported()) {
				return Promise.resolve({ status: 'unsupported', created: 0, errors: 0, total: state.cells.length });
			}
			return start(options && options.onProgress, options && options.chunkSize);
		}

		/* 작업 취소 + 도형·리스너 모두 정리 + 셀 정의도 버린다. (격자 표시 끄기, 분석 변경) */
		function clear() {
			stopJob();
			var removed = removeObjects();
			state.cells = [];
			return removed;
		}

		return {
			setMap: function (map) {
				if (state.map && state.map !== map) {
					clear();
				}
				state.map = map || null;
			},
			setPickHandler: function (fn) {
				state.pickHandler = typeof fn === 'function' ? fn : null;
			},
			isSupported: isSupported,
			render: render,
			restore: restore,
			cancel: clear,
			clear: clear,
			count: function () {
				return state.objects.length;
			},
			isRendering: function () {
				return state.job !== null;
			},
			hasCells: function () {
				return state.cells.length > 0;
			},
			// 보관 중인 셀 정의 사본 (원시 데이터)
			getCells: function () {
				return state.cells.map(copyCell);
			},
			getStats: function () {
				return { created: state.stats.created, removed: state.stats.removed, createErrors: state.stats.createErrors,
					removeErrors: state.stats.removeErrors, objects: state.objects.length, cells: state.cells.length,
					rendering: state.job !== null, colors: Object.keys(state.colors).length };
			}
		};
	}

	function copyCell(cell) {
		return {
			id: String(cell.id),
			col: cell.col,
			row: cell.row,
			ring: cell.ring.map(function (p) {
				return [p[0], p[1]];
			}),
			center: cell.center ? [cell.center[0], cell.center[1]] : null,
			coverageRatio: cell.coverageRatio,
			coverageClass: cell.coverageClass,
			buildingCount: cell.buildingCount,
			primaryBuildingCount: cell.primaryBuildingCount,
			boundary: !!cell.boundary,
			smallBoundary: !!cell.smallBoundary,
			empty: !!cell.empty
		};
	}

	/*
	 * 브라우저: window.gisGridRenderer(도형)와 window.gisGridModel(셀 변환·색상·범례 함수)을 만들고, 지도가 준비되면
	 * 연결한다. 화면 연동은 spatial-grid.js가 한다.
	 */
	function install(win, doc) {
		var renderer = createRenderer({
			vw: function () {
				return win.vw;
			},
			raf: function (cb) {
				return win.requestAnimationFrame(cb);
			},
			cancelRaf: function (id) {
				win.cancelAnimationFrame(id);
			},
			console: win.console
		});
		doc.addEventListener('gis:mapready', function (event) {
			renderer.setMap(event.detail && event.detail.map);
		});
		if (win.gisMap) {
			renderer.setMap(win.gisMap);
		}
		win.gisGridRenderer = renderer;
		win.gisGridModel = model;
		return renderer;
	}

	var model = {
		MAX_CELLS: MAX_CELLS,
		CHUNK_SIZE: CHUNK_SIZE,
		INSET: INSET,
		COVERAGE_LIMITS: COVERAGE_LIMITS,
		COVERAGE_COLORS: COVERAGE_COLORS,
		SMALL_BOUNDARY_COLOR: SMALL_BOUNDARY_COLOR,
		coverageClass: coverageClass,
		isEmptyCell: isEmptyCell,
		prepareCells: prepareCells,
		cellStyle: cellStyle,
		legend: legend,
		createRenderer: createRenderer,
		install: install
	};
	return model;
});
