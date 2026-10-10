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
 */
(function () {
	'use strict';

	var COLORS = {
		previewCircle: [100, 116, 139, 70],
		resultCircle: [37, 99, 235, 45],
		INSIDE: [37, 99, 235, 150],
		PARTIAL: [234, 140, 0, 170],
		highlight: [220, 38, 38, 200]
	};

	var map = null;
	var pickHandler = null;
	// { kind: 'circle'|'marker'|'building', spec, obj, buildingId? }
	var items = [];
	var highlightedId = null;

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
			return item.buildingId === highlightedId ? COLORS.highlight : COLORS[item.spec.relation];
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

	function add(kind, spec, buildingId) {
		var item = { kind: kind, spec: spec, obj: null, buildingId: buildingId };
		try {
			build(item);
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
	}

	function drawCenter(center, radius, preview) {
		add('circle', {
			lon: center.lon, lat: center.lat, radius: radius,
			fill: preview ? COLORS.previewCircle : COLORS.resultCircle
		});
		add('marker', { lon: center.lon, lat: center.lat, label: preview ? '분석 전 · 범위 미리보기' : '분석 중심' });
	}

	// 분석 전 미리보기: 원과 중심점만 표시한다.
	function showPreview(center, radius) {
		clear();
		if (!isSupported()) {
			return false;
		}
		drawCenter(center, radius, true);
		return items.length > 0;
	}

	/*
	 * buildings: [{ id, relation: 'INSIDE'|'PARTIAL', polygons: [rings[[lon, lat]]] }]
	 * 반환: 실제로 그린 건물 수(일부 실패 시 줄어든다)
	 */
	function showResult(center, radius, buildings) {
		clear();
		if (!isSupported()) {
			return 0;
		}
		drawCenter(center, radius, false);
		var drawn = 0;
		buildings.forEach(function (b) {
			var ok = false;
			(b.polygons || []).forEach(function (rings) {
				var outer = rings[0] || [];
				// 닫는 점(첫 점 반복)은 제외하고 넘긴다.
				var ring = outer.length > 1 ? outer.slice(0, outer.length - 1) : outer;
				if (ring.length >= 3 && add('building', { ring: ring, relation: b.relation }, b.id)) {
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
			if (item.buildingId !== buildingId || !item.obj) {
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
		setPickHandler: function (fn) {
			pickHandler = fn;
		}
	};
})();
