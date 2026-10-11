/*
 * GIS 3D 지도 - 반경 분석 도형 표시 (VWorld 도형 API)
 *
 * 사용하는 공개 API (VWViewerStartup.v30 스크립트에서 확인):
 *   vw.geom.CircleZ(vw.CoordZ, 반지름 m)   : 지면에 붙인 원(타원체 기준 수평 반지름)
 *   vw.geom.PointZ(vw.CoordZ)              : 이미지+라벨 마커
 *   vw.geom.PolygonZ(vw.Collection<vw.Coord>) : 지면에 붙인 다각형(바깥 테두리 하나, 내부 구멍 표현 불가)
 *   setFillColor(vw.Color), create(), redraw(), addEventListener(fn) - create() 이후에 등록해야 클릭이 연결된다.
 *   vw.Map.removeObject(obj)               : 해당 도형만 삭제 (측정 도형은 유지)
 * - 분석 도형은 이 모듈이 정의(spec)와 함께 관리하고, 개별로 삭제한다.
 * - 측정 결과 초기화(vw.Map.clear)는 분석 도형까지 지우므로 restore()로 정의에서 다시 만든다.
 * - MultiPolygon은 조각마다 PolygonZ를 만든다. 구멍은 지도에 표시하지 못한다(서버 판정에는 반영).
 * - 결과는 실시간(live, 파랑/주황)과 저장본(saved, 보라/분홍) 색상표로 구분하고, 중심점 문구로도 구분한다.
 *   어느 쪽이든 그리기 전에 이전 분석 도형을 모두 지우므로 두 결과가 겹쳐 표시되지 않는다.
 * - 격자 밀집도를 지도에 표시하는 동안(spatial-grid.js)은 setBuildingsVisible(false)로 건물 도형만 지도에서 내린다.
 *   정의는 그대로 두므로 다시 켜면 같은 건물을 그린다. 반경 원과 중심점은 유지하고, 숨긴 동안에는 restore()와
 *   강조 표시도 건물 도형을 다시 만들지 않는다. clear()(새 결과·초기화)는 다시 보이는 상태로 돌아간다.
 */
(function () {
	'use strict';

	var COLORS = {
		previewCircle: [100, 116, 139, 70],
		highlight: [220, 38, 38, 200]
	};

	// 결과 종류별 색상표. 관계(완전 포함/경계 걸침) 구분은 두 색상표 모두 유지한다.
	var PALETTES = {
		live: { circle: [37, 99, 235, 45], INSIDE: [37, 99, 235, 150], PARTIAL: [234, 140, 0, 170] },
		saved: { circle: [124, 58, 237, 45], INSIDE: [124, 58, 237, 150], PARTIAL: [219, 39, 119, 160] }
	};

	var LABELS = { live: '분석 중심', saved: '저장된 분석' };

	var map = null;
	var pickHandler = null;
	// { kind: 'circle'|'marker'|'building', spec, obj, buildingId? }
	var items = [];
	var highlightedId = null;
	var currentStyle = null; // null(없음) | 'preview' | 'live' | 'saved'
	var buildingsVisible = true;

	function isSupported() {
		return !!(window.vw && vw.geom && typeof vw.geom.CircleZ === 'function'
			&& typeof vw.geom.PolygonZ === 'function' && typeof vw.geom.PointZ === 'function'
			&& typeof vw.Collection === 'function' && typeof vw.Coord === 'function'
			&& typeof vw.CoordZ === 'function' && typeof vw.Color === 'function');
	}

	function setMap(readyMap) {
		map = readyMap;
	}

	function color(rgba) {
		return new vw.Color(rgba[0], rgba[1], rgba[2], rgba[3]);
	}

	function remove(item) {
		if (!item.obj) {
			return;
		}
		try {
			if (typeof item.obj.removeEventListener === 'function') {
				item.obj.removeEventListener();
			}
		} catch (e) {
			// 이미 엔진에서 지워진 도형일 수 있다.
		}
		try {
			if (map && typeof map.removeObject === 'function') {
				map.removeObject(item.obj);
			}
		} catch (e) {
			console.warn('[GIS 3D 지도] 분석 도형 삭제 중 오류', e);
		}
		item.obj = null;
	}

	function fillFor(item) {
		if (item.kind === 'building') {
			return item.buildingId === highlightedId ? COLORS.highlight : PALETTES[item.spec.style][item.spec.relation];
		}
		return item.spec.fill;
	}

	function build(item) {
		var spec = item.spec;
		var obj;
		if (item.kind === 'circle') {
			obj = new vw.geom.CircleZ(new vw.CoordZ(spec.lon, spec.lat, 0), spec.radius);
			if (typeof obj.setOutLineVisible === 'function') {
				// 지면에 붙인 도형의 외곽선은 엔진(Cesium)에서 지원하지 않는다.
				obj.setOutLineVisible(false);
			}
		} else if (item.kind === 'marker') {
			obj = new vw.geom.PointZ(new vw.CoordZ(spec.lon, spec.lat, 0));
			obj.setName(spec.label);
			if (typeof obj.setFont === 'function') {
				obj.setFont('sans-serif');
			}
			if (typeof obj.setFontSize === 'function') {
				obj.setFontSize(14);
			}
		} else {
			obj = new vw.geom.PolygonZ(new vw.Collection(spec.ring.map(function (p) {
				return new vw.Coord(p[0], p[1]);
			})));
		}
		if (item.kind !== 'marker') {
			obj.setFillColor(color(fillFor(item)));
		}
		obj.create();
		if (item.kind === 'building' && typeof obj.addEventListener === 'function') {
			var id = item.buildingId;
			obj.addEventListener(function () {
				if (pickHandler) {
					pickHandler(id);
				}
			});
		}
		item.obj = obj;
	}

	function shouldDraw(item) {
		return item.kind !== 'building' || buildingsVisible;
	}

	function add(kind, spec, buildingId) {
		var item = { kind: kind, spec: spec, obj: null, buildingId: buildingId };
		try {
			if (shouldDraw(item)) {
				build(item);
			}
			items.push(item);
			return true;
		} catch (e) {
			console.warn('[GIS 3D 지도] 분석 도형 생성 실패', e);
			remove(item);
			return false;
		}
	}

	function clear() {
		items.forEach(remove);
		items = [];
		highlightedId = null;
		currentStyle = null;
		buildingsVisible = true;
	}

	/* 건물 도형만 지도에서 내리거나(false) 다시 그린다(true). 반경 원과 중심점은 그대로다. */
	function setBuildingsVisible(visible) {
		var next = visible !== false;
		if (next === buildingsVisible) {
			return;
		}
		buildingsVisible = next;
		items.forEach(function (item) {
			if (item.kind !== 'building') {
				return;
			}
			if (!next) {
				remove(item);
				return;
			}
			if (!item.obj) {
				try {
					build(item);
				} catch (e) {
					console.warn('[GIS 3D 지도] 분석 도형 다시 표시 실패', e);
				}
			}
		});
	}

	function paletteName(style) {
		return style === 'saved' ? 'saved' : 'live';
	}

	// style: 'preview' | 'live' | 'saved', label: 중심점 문구(없으면 종류별 기본 문구)
	function drawCenter(center, radius, style, label) {
		add('circle', {
			lon: center.lon, lat: center.lat, radius: radius,
			fill: style === 'preview' ? COLORS.previewCircle : PALETTES[paletteName(style)].circle
		});
		add('marker', {
			lon: center.lon, lat: center.lat,
			label: label || (style === 'preview' ? '분석 전 · 범위 미리보기' : LABELS[paletteName(style)])
		});
	}

	// 분석 전 미리보기: 원과 중심점만 표시한다.
	function showPreview(center, radius) {
		clear();
		if (!isSupported()) {
			return false;
		}
		drawCenter(center, radius, 'preview');
		currentStyle = 'preview';
		return items.length > 0;
	}

	/*
	 * buildings: [{ id, relation: 'INSIDE'|'PARTIAL', polygons: [rings[[lon, lat]]] }]
	 * options: { style: 'live'(기본)|'saved', label: 중심점 문구 } - 생략하면 기존(실시간) 표시와 같다.
	 * 반환: 실제로 그린 건물 수(일부 실패 시 줄어든다)
	 */
	function showResult(center, radius, buildings, options) {
		clear();
		if (!isSupported()) {
			return 0;
		}
		var style = paletteName(options && options.style);
		drawCenter(center, radius, style, options && options.label);
		currentStyle = style;
		var drawn = 0;
		buildings.forEach(function (b) {
			var ok = false;
			(b.polygons || []).forEach(function (rings) {
				var outer = rings[0] || [];
				// 닫는 점(첫 점 반복)은 제외하고 넘긴다.
				var ring = outer.length > 1 ? outer.slice(0, outer.length - 1) : outer;
				if (ring.length >= 3 && add('building', { ring: ring, relation: b.relation, style: style }, b.id)) {
					ok = true;
				}
			});
			if (ok) {
				drawn++;
			}
		});
		return drawn;
	}

	function isDrawn(buildingId) {
		return items.some(function (item) {
			return item.buildingId === buildingId && item.obj;
		});
	}

	function redrawBuilding(buildingId) {
		items.forEach(function (item) {
			if (item.buildingId !== buildingId || !item.obj || !shouldDraw(item)) {
				return;
			}
			remove(item);
			try {
				build(item);
			} catch (e) {
				console.warn('[GIS 3D 지도] 분석 도형 강조 실패', e);
			}
		});
	}

	function highlight(buildingId) {
		var previous = highlightedId;
		highlightedId = buildingId;
		if (previous !== null && previous !== buildingId) {
			redrawBuilding(previous);
		}
		if (buildingId !== null) {
			redrawBuilding(buildingId);
		}
		return buildingId !== null && isDrawn(buildingId);
	}

	// vw.Map.clear()로 엔진 도형이 모두 지워진 뒤 정의에서 다시 만든다.
	function restore() {
		var restored = 0;
		items.forEach(function (item) {
			remove(item);
			if (!shouldDraw(item)) {
				return; // 숨긴 건물 도형은 다시 켤 때 그린다.
			}
			try {
				build(item);
				restored++;
			} catch (e) {
				console.warn('[GIS 3D 지도] 분석 도형 복구 실패', e);
			}
		});
		return restored;
	}

	window.gisAnalysisRenderer = {
		isSupported: isSupported,
		setMap: setMap,
		showPreview: showPreview,
		showResult: showResult,
		highlight: highlight,
		isDrawn: isDrawn,
		restore: restore,
		clear: clear,
		count: function () {
			return items.length;
		},
		// 지금 지도에 그려진 분석 도형의 종류: null | 'preview' | 'live' | 'saved'
		getStyle: function () {
			return items.length ? currentStyle : null;
		},
		setPickHandler: function (fn) {
			pickHandler = fn;
		},
		// 격자 밀집도 표시 중 건물 도형 숨기기 (spatial-grid.js)
		setBuildingsVisible: setBuildingsVisible,
		areBuildingsVisible: function () {
			return buildingsVisible;
		}
	};
})();
