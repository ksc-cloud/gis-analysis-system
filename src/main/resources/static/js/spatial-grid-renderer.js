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
 * - 핫스팟(8-7-4): prepareHotspotCells로 핫스팟 응답의 셀을 준비하고 render(cells, { styleFn: hotspotStyle })로
 *   그린다. styleFn은 그리기 전에 셀마다 한 번만 부르고 결과(rgba)를 셀 정의에 보관해 restore()에서 다시 쓴다.
 *   스타일이 잘못되었거나 styleFn이 예외를 내면 그 셀만 그리지 않는다(격자 밀집도 색으로 대신 칠하지 않는다).
 *   격자 밀집도 화면과 섞이지 않도록 핫스팟은 attachRenderer로 만든 별도 renderer를 쓴다.
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
	var SKIPPED_STYLE = 'style';

	// coverageRatio(0~1) 단계: 0~5%, 5~15%, 15~30%, 30~50%, 50% 초과
	var COVERAGE_LIMITS = [0.05, 0.15, 0.30, 0.50];
	var COVERAGE_LABELS = ['0~5%', '5~15%', '15~30%', '30~50%', '50% 초과'];

	// 단계별 채움색 (밝은 노랑 → 진한 빨강). 경계 셀은 불투명도를 낮추고, 원 안 면적이 작은 셀은 회색으로 따로 칠한다.
	var COVERAGE_COLORS = [[255, 237, 160, 150], [254, 196, 79, 160], [253, 141, 60, 170], [227, 74, 51, 180],
		[179, 0, 0, 190]];
	var BOUNDARY_ALPHA = 0.6;
	var SMALL_BOUNDARY_COLOR = [148, 163, 184, 110];

	// 핫스팟 클래스 (Python HotspotClass와 같은 이름). 유의 수준 7단계(빨강 → 흰색 → 파랑, ColorBrewer RdBu)와
	// 검정하지 않은 셀(NOT_TESTED, 회색)을 따로 둔다. 지도와 범례가 이 상수 하나를 같이 쓴다.
	var HOTSPOT_CLASSES = ['HOT_99', 'HOT_95', 'HOT_90', 'NOT_SIGNIFICANT', 'COLD_90', 'COLD_95', 'COLD_99', 'NOT_TESTED'];
	var HOTSPOT_COLORS = {
		HOT_99: [178, 24, 43, 200],
		HOT_95: [239, 138, 98, 185],
		HOT_90: [253, 219, 199, 175],
		NOT_SIGNIFICANT: [247, 247, 247, 90],
		COLD_90: [209, 229, 240, 175],
		COLD_95: [103, 169, 207, 185],
		COLD_99: [33, 102, 172, 200],
		NOT_TESTED: [100, 116, 139, 130]
	};
	var HOTSPOT_LABELS = {
		HOT_99: '핫스팟 (신뢰수준 99%)',
		HOT_95: '핫스팟 (신뢰수준 95%)',
		HOT_90: '핫스팟 (신뢰수준 90%)',
		NOT_SIGNIFICANT: '유의하지 않음 (검정함)',
		COLD_90: '콜드스팟 (신뢰수준 90%)',
		COLD_95: '콜드스팟 (신뢰수준 95%)',
		COLD_99: '콜드스팟 (신뢰수준 99%)',
		NOT_TESTED: '검정하지 않음 (작은 경계 셀, 이웃 없음 등)'
	};

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
		return {
			id: cellId(feature, props),
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

	function cellId(feature, props) {
		var id = feature.id;
		return typeof id === 'string' || isFiniteNumber(id) ? String(id) : (props.col + ':' + props.row);
	}

	/* 원시 값만: 유한한 숫자는 그대로, 아니면 null */
	function finiteOrNull(value) {
		return isFiniteNumber(value) ? value : null;
	}

	/*
	 * 핫스팟 셀 하나 → 원시 데이터 셀 정의, 좌표나 hotspotClass가 올바르지 않으면 null.
	 * 건물 수는 요구하지 않는다(핫스팟 응답에 없다). 통계 값은 hotspot에 원시 값으로 보관한다.
	 */
	function toHotspotCell(feature, inset) {
		if (!feature || typeof feature !== 'object' || feature.type !== 'Feature') {
			return null;
		}
		var props = feature.properties;
		if (!props || typeof props !== 'object' || HOTSPOT_CLASSES.indexOf(props.hotspotClass) < 0) {
			return null;
		}
		var points = outerRing(feature.geometry);
		if (!points) {
			return null;
		}
		var center = isFiniteNumber(props.centerLon) && isFiniteNumber(props.centerLat)
			? [props.centerLon, props.centerLat] : ringCenter(points);
		return {
			id: cellId(feature, props),
			col: isFiniteNumber(props.col) ? props.col : null,
			row: isFiniteNumber(props.row) ? props.row : null,
			ring: insetRing(points, center, inset),
			center: center,
			coverageRatio: finiteOrNull(props.coverageRatio),
			boundary: props.boundary === true,
			smallBoundary: props.smallBoundary === true,
			hotspot: {
				hotspotClass: props.hotspotClass,
				bin: finiteOrNull(props.bin),
				giZ: finiteOrNull(props.giZ),
				pValue: finiteOrNull(props.pValue),
				qValue: finiteOrNull(props.qValue),
				reason: typeof props.reason === 'string' ? props.reason : null,
				neighborCount: finiteOrNull(props.neighborCount)
			}
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
		var maxCells = maxCellsOption(options);
		var inset = insetOption(options);
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
		cells = limitCells(cells, maxCells);
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

	function maxCellsOption(options) {
		return options && options.maxCells > 0 ? Math.floor(options.maxCells) : MAX_CELLS;
	}

	function insetOption(options) {
		return options && options.inset >= 0 && options.inset < 0.5 ? options.inset : INSET;
	}

	/* 상한을 넘으면 분석 중심(셀 0,0)에서 가까운 셀부터 남긴다. 위치를 모르는 셀은 맨 뒤로. 넘지 않으면 순서 그대로. */
	function limitCells(cells, maxCells) {
		if (cells.length <= maxCells) {
			return cells;
		}
		return cells.map(function (cell, index) {
			var d = cell.col !== null && cell.row !== null ? cell.col * cell.col + cell.row * cell.row : Infinity;
			return { cell: cell, d: d, index: index };
		}).sort(function (a, b) {
			return a.d - b.d || a.index - b.index;
		}).slice(0, maxCells).map(function (entry) {
			return entry.cell;
		});
	}

	/*
	 * 핫스팟 응답(Java 응답, result, cells 중 무엇이든) → 그릴 셀 목록과 개수 정보
	 * 빈 셀(건물이 없는 셀)도 통계 대상이고 콜드스팟일 수 있으므로 빼지 않는다. 셀 순서는 응답 순서를 따른다.
	 * options: { maxCells: 1345(기본), inset: 0.02(기본) }
	 * 반환: { cells, total, invalid, emptyExcluded(항상 0), available, shown, truncated, maxCells }
	 * FeatureCollection이 아니면 TypeError
	 */
	function prepareHotspotCells(source, options) {
		var fc = featureCollection(source);
		if (!fc) {
			throw new TypeError('hotspot cells(FeatureCollection)가 필요합니다.');
		}
		var maxCells = maxCellsOption(options);
		var inset = insetOption(options);
		var invalid = 0;
		var cells = [];
		fc.features.forEach(function (feature) {
			var cell = toHotspotCell(feature, inset);
			if (cell) {
				cells.push(cell);
			} else {
				invalid++;
			}
		});
		var available = cells.length;
		cells = limitCells(cells, maxCells);
		return {
			cells: cells,
			total: fc.features.length,
			invalid: invalid,
			emptyExcluded: 0,
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

	/*
	 * 핫스팟 셀 → 채움색 { key, rgba }, 클래스를 모르면 null (render의 styleFn으로 쓴다)
	 * 경계 셀도 옅게 칠하지 않는다(옅은 색이 낮은 유의 수준처럼 보이지 않게). 작은 경계 셀은 Python이 NOT_TESTED로 보낸다.
	 */
	function hotspotStyle(cell) {
		var hotspotClass = cell && cell.hotspot ? cell.hotspot.hotspotClass : null;
		if (HOTSPOT_CLASSES.indexOf(hotspotClass) < 0) {
			return null;
		}
		return { key: hotspotClass, rgba: HOTSPOT_COLORS[hotspotClass].slice() };
	}

	/* 핫스팟 범례: 유의 수준 7단계(group 'scale') + 따로 표시하는 검정하지 않은 셀(group 'notTested') */
	function hotspotLegend() {
		return HOTSPOT_CLASSES.map(function (hotspotClass) {
			return { key: hotspotClass, label: HOTSPOT_LABELS[hotspotClass], rgba: HOTSPOT_COLORS[hotspotClass].slice(),
				group: hotspotClass === 'NOT_TESTED' ? 'notTested' : 'scale' };
		});
	}

	function isColorComponent(value) {
		return isFiniteNumber(value) && Math.floor(value) === value && value >= 0 && value <= 255;
	}

	/* styleFn 반환값 → { rgba } (원시 값 사본), 올바르지 않으면 null. rgba는 0~255 정수 4개, key는 있으면 문자열. */
	function normalizeStyle(style) {
		if (!style || typeof style !== 'object' || !Array.isArray(style.rgba) || style.rgba.length !== 4
				|| !style.rgba.every(isColorComponent)) {
			return null;
		}
		if (style.key !== undefined && typeof style.key !== 'string') {
			return null;
		}
		return { rgba: style.rgba.slice() };
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
			job: null,          // 진행 중인 작업 { id, index, rafId, resolve, created, errors, styled, styleErrors }
			jobSeq: 0,
			styled: false,      // 셀 정의에 styleFn으로 정한 스타일(cell.style)이 있는지
			pickHandler: null,
			stats: { created: 0, removed: 0, createErrors: 0, removeErrors: 0, styleErrors: 0 }
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

		/*
		 * 셀의 채움색. styleFn으로 정한 셀은 보관한 rgba(색상 캐시 key는 rgba로 만들어 기본 key와 겹치지 않는다),
		 * 아니면 기존 격자 밀집도 색. 그릴 수 없는 스타일이면 null.
		 */
		function styleOf(cell) {
			if (!('style' in cell)) {
				return cellStyle(cell);
			}
			return cell.style ? { key: 's:' + cell.style.rgba.join(','), rgba: cell.style.rgba } : null;
		}

		/* 도형 하나를 만든다. 반환: true(만듦), false(엔진 오류), SKIPPED_STYLE(스타일이 잘못되어 그리지 않음) */
		function build(cell) {
			var style = styleOf(cell);
			if (!style) {
				state.stats.styleErrors++;
				return SKIPPED_STYLE;
			}
			var g = vw();
			var obj = null;
			try {
				obj = new g.geom.PolygonZ(new g.Collection(cell.ring.map(function (p) {
					return new g.Coord(p[0], p[1]);
				})));
				obj.setFillColor(color(style));
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

		/* 작업 결과. styleFn으로 그린 작업이면 styleErrors(스타일 때문에 그리지 않은 셀 수, errors에도 포함)를 더한다. */
		function outcome(status, created, errors, total, styled, styleErrors) {
			var result = { status: status, created: created, errors: errors, total: total };
			if (styled) {
				result.styleErrors = styleErrors;
			}
			return result;
		}

		function finishJob(job, status) {
			if (state.job === job) {
				state.job = null;
			}
			job.done = true;
			job.resolve(outcome(status, job.created, job.errors, job.cells.length, job.styled, job.styleErrors));
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
					var built = build(job.cells[job.index]);
					if (built === true) {
						job.created++;
					} else {
						job.errors++;
						if (built === SKIPPED_STYLE) {
							job.styleErrors++;
						}
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
					done: false, chunkSize: chunkSize > 0 ? Math.min(Math.floor(chunkSize), CHUNK_SIZE) : CHUNK_SIZE,
					styled: state.styled, styleErrors: 0 };
				if (!cells.length) {
					resolve(outcome('done', 0, 0, 0, job.styled, 0));
					return;
				}
				state.job = job;
				schedule(job, onProgress);
			});
		}

		/*
		 * styleFn을 셀마다 한 번씩 불러 결과를 셀 정의(cell.style)에 보관한다. styleFn에는 셀 사본을 넘겨 보관한
		 * 셀을 바꾸지 못하게 한다. 예외나 잘못된 반환값은 cell.style = null(그 셀은 그리지 않음)로 두고,
		 * 경고는 한 번만 남긴다.
		 */
		function applyStyles(styleFn) {
			var failed = 0;
			var firstError = null;
			state.cells.forEach(function (cell) {
				var style = null;
				try {
					style = normalizeStyle(styleFn(copyCell(cell)));
				} catch (e) {
					firstError = firstError || e;
				}
				cell.style = style;
				if (!style) {
					failed++;
				}
			});
			if (failed) {
				log.warn('[GIS 3D 지도] 스타일이 올바르지 않아 그리지 않는 격자 셀: ' + failed + '개', firstError);
			}
		}

		/*
		 * 셀을 그린다. 이전 작업은 취소하고, 이전 도형은 모두 지운 뒤 시작한다.
		 * cells: prepareCells(...).cells 또는 prepareHotspotCells(...).cells
		 * options: { onProgress({ created, errors, total }), chunkSize(최대 100), styleFn(cellCopy) → { rgba, key? } }
		 *   styleFn이 없으면 격자 밀집도 색(cellStyle)으로 그린다. 함수가 아닌 값이면 아무것도 그리지 않고 'failed'.
		 * 반환: Promise<{ status: 'done' | 'cancelled' | 'failed' | 'unsupported', created, errors, total }>
		 *   styleFn으로 그리면 styleErrors(스타일 때문에 그리지 않은 셀 수, errors에 포함)가 더해진다.
		 */
		function render(cells, options) {
			stopJob();
			removeObjects();
			var styleFn = options ? options.styleFn : undefined;
			// 원시 값만 복사해 보관한다. (호출한 쪽 배열이나 응답 객체를 붙잡지 않는다)
			state.cells = (Array.isArray(cells) ? cells : []).slice(0, MAX_CELLS).map(copyCell);
			state.styled = false;
			if (styleFn !== undefined && styleFn !== null && typeof styleFn !== 'function') {
				// 다른 색으로 대신 그리면 다른 분석처럼 보이므로 그리지 않는다. 다시 그릴(restore) 셀도 남기지 않는다.
				var requested = state.cells.length;
				state.cells = [];
				log.warn('[GIS 3D 지도] 격자 styleFn이 함수가 아닙니다.');
				return Promise.resolve(outcome('failed', 0, 0, requested, true, 0));
			}
			if (styleFn) {
				state.styled = true;
				applyStyles(styleFn);
			} else {
				state.cells.forEach(function (cell) {
					delete cell.style;  // 이전에 정한 스타일은 쓰지 않는다.
				});
			}
			if (!isSupported()) {
				return Promise.resolve(outcome('unsupported', 0, 0, state.cells.length, state.styled, 0));
			}
			return start(options && options.onProgress, options && options.chunkSize);
		}

		/*
		 * 측정 초기화(map.clear()) 뒤 보관한 셀 정의로 다시 그린다. 엔진에서 이미 지워진 도형은 목록에서만 버린다.
		 * styleFn으로 정한 스타일은 보관한 것을 그대로 쓴다(styleFn을 다시 부르지 않는다). 그릴 셀이 없으면 바로 끝난다.
		 */
		function restore(options) {
			stopJob();
			removeObjects();
			if (!isSupported()) {
				return Promise.resolve(outcome('unsupported', 0, 0, state.cells.length, state.styled, 0));
			}
			return start(options && options.onProgress, options && options.chunkSize);
		}

		/* 작업 취소 + 도형·리스너 모두 정리 + 셀 정의도 버린다. (격자 표시 끄기, 분석 변경) */
		function clear() {
			stopJob();
			var removed = removeObjects();
			state.cells = [];
			state.styled = false;
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
					removeErrors: state.stats.removeErrors, styleErrors: state.stats.styleErrors, objects: state.objects.length,
					cells: state.cells.length, rendering: state.job !== null, colors: Object.keys(state.colors).length };
			}
		};
	}

	/*
	 * 셀 정의 사본 (원시 데이터). 핫스팟 셀은 hotspot 통계 값을, styleFn으로 그린 셀은 style(rgba 또는 null)을
	 * 있을 때만 복사한다. 격자 밀집도 셀의 사본 모양은 그대로다.
	 */
	function copyCell(cell) {
		var copy = cell.hotspot ? copyHotspotCell(cell) : copyGridCell(cell);
		if ('style' in cell) {
			copy.style = cell.style ? { rgba: cell.style.rgba.slice() } : null;
		}
		return copy;
	}

	function copyHotspotCell(cell) {
		var h = cell.hotspot;
		return {
			id: String(cell.id),
			col: cell.col,
			row: cell.row,
			ring: cell.ring.map(function (p) {
				return [p[0], p[1]];
			}),
			center: cell.center ? [cell.center[0], cell.center[1]] : null,
			coverageRatio: cell.coverageRatio,
			boundary: !!cell.boundary,
			smallBoundary: !!cell.smallBoundary,
			hotspot: { hotspotClass: h.hotspotClass, bin: h.bin, giZ: h.giZ, pValue: h.pValue, qValue: h.qValue,
				reason: h.reason, neighborCount: h.neighborCount }
		};
	}

	function copyGridCell(cell) {
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
	 * 브라우저용 renderer 하나를 만들고 지도에 연결한다(gis:mapready, 이미 준비된 window.gisMap).
	 * 부를 때마다 독립된 renderer(자기 도형·리스너·색상만 관리)와 document 리스너 하나가 생기므로 화면마다 한 번만
	 * 만든다. 더 쓰지 않을 때는 renderer.detach()로 도형을 지우고 그 리스너를 뗀다.
	 */
	function attachRenderer(win, doc) {
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
		function onMapReady(event) {
			renderer.setMap(event.detail && event.detail.map);
		}
		doc.addEventListener('gis:mapready', onMapReady);
		if (win.gisMap) {
			renderer.setMap(win.gisMap);
		}
		// 도형·리스너·셀 정의를 지우고 지도 연결과 gis:mapready 리스너를 뗀다. 여러 번 불러도 된다.
		renderer.detach = function () {
			renderer.clear();
			if (typeof doc.removeEventListener === 'function') {
				doc.removeEventListener('gis:mapready', onMapReady);
			}
			renderer.setMap(null);
		};
		return renderer;
	}

	/*
	 * 브라우저: window.gisGridRenderer(격자 밀집도 도형)와 window.gisGridModel(셀 변환·색상·범례 함수)을 만들고,
	 * 지도가 준비되면 연결한다. 화면 연동은 spatial-grid.js가 한다.
	 */
	function install(win, doc) {
		var renderer = attachRenderer(win, doc);
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
		HOTSPOT_CLASSES: HOTSPOT_CLASSES,
		HOTSPOT_COLORS: HOTSPOT_COLORS,
		coverageClass: coverageClass,
		isEmptyCell: isEmptyCell,
		prepareCells: prepareCells,
		prepareHotspotCells: prepareHotspotCells,
		cellStyle: cellStyle,
		hotspotStyle: hotspotStyle,
		legend: legend,
		hotspotLegend: hotspotLegend,
		createRenderer: createRenderer,
		attachRenderer: attachRenderer,
		install: install
	};
	return model;
});
