/*
 * GIS 3D 지도 - 레이어 표시/숨김
 *
 * VWorld 기본 레이어 중 기본으로 표시되는 3개만 제공한다. (vworld.json 기준)
 *   facility_build: 3D 건물(3차원 입체모형 LoD4), poi_base: 지명(명칭 한글), hybrid_bound: 행정경계
 * - 레이어 요소는 vw.Map.getElementById(id)로 찾고, 요소의 show()/hide()로 표시 상태를 바꾼다.
 * - 찾지 못했거나 show/hide가 없는 레이어는 비활성화한다.
 * - 변경 후 'gis:layerchange' 이벤트({ id, visible })를 발생시킨다.
 */
(function () {
	'use strict';

	var inputs = document.querySelectorAll('#layer-list input[data-layer]');
	var hint = document.getElementById('layer-hint');
	if (!inputs.length) {
		return;
	}

	var registered = false;
	var map = null;

	function findLayer(id) {
		try {
			var element = map.getElementById(id);
			if (element && typeof element.show === 'function' && typeof element.hide === 'function') {
				return element;
			}
		} catch (e) {
			console.warn('[GIS 3D 지도] 레이어를 찾지 못했습니다: ' + id, e);
		}
		return null;
	}

	// 엔진 요소의 표시 상태. 읽을 수 없으면 null.
	function readVisible(element) {
		try {
			if (typeof element.visible === 'boolean') {
				return element.visible;
			}
			if (element._options && typeof element._options.visible === 'boolean') {
				return element._options.visible;
			}
		} catch (e) {
			// 상태를 읽을 수 없는 경우 아래에서 null 처리
		}
		return null;
	}

	function disable(input, reason) {
		input.disabled = true;
		input.checked = false;
		var label = input.parentNode;
		if (label && !label.querySelector('.layer-list__unavailable')) {
			var note = document.createElement('em');
			note.className = 'layer-list__unavailable';
			note.textContent = reason;
			label.appendChild(note);
		}
	}

	function sync(input, element) {
		var visible = readVisible(element);
		if (visible !== null) {
			input.checked = visible;
		}
		return input.checked;
	}

	function onToggle(input, element) {
		var id = input.getAttribute('data-layer');
		var wanted = input.checked;
		try {
			if (wanted) {
				element.show();
			} else {
				element.hide();
			}
		} catch (e) {
			console.warn('[GIS 3D 지도] 레이어 표시 변경 실패: ' + id, e);
			input.checked = !wanted;
			if (hint) {
				hint.textContent = '레이어 표시 상태를 변경하지 못했습니다.';
			}
			return;
		}
		var visible = sync(input, element);
		if (hint) {
			hint.textContent = '';
		}
		document.dispatchEvent(new CustomEvent('gis:layerchange', { detail: { id: id, visible: visible } }));
	}

	function register(readyMap) {
		if (registered || !readyMap || typeof readyMap.getElementById !== 'function') {
			return;
		}
		registered = true;
		map = readyMap;

		var available = 0;
		Array.prototype.forEach.call(inputs, function (input) {
			var element = findLayer(input.getAttribute('data-layer'));
			if (!element) {
				disable(input, ' (사용 불가)');
				return;
			}
			available++;
			input.disabled = false;
			sync(input, element);
			input.addEventListener('change', function () {
				onToggle(input, element);
			});
		});
		if (hint) {
			hint.textContent = available ? '' : '이 지도 버전에서는 레이어를 제어할 수 없습니다.';
		}
	}

	document.addEventListener('gis:mapready', function (event) {
		register(event.detail && event.detail.map);
	});
	if (window.gisMap) {
		register(window.gisMap);
	}
})();
