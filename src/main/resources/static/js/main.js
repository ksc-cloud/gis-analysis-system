/*
 * GIS 3D 지도 - 레이아웃 제어
 * - 넓은 화면: 사이드바/정보 패널을 접고 펼친다.
 * - 작은 화면(900px 이하): 사이드바/정보 패널을 슬라이드 패널로 열고 닫는다.
 * - 입력칸에서 누른 키가 VWorld 지도 단축키로 전달되지 않게 한다. (아래 keepKeysInFields)
 */
(function () {
	'use strict';

	var MOBILE_QUERY = window.matchMedia('(max-width: 900px)');

	var app = document.querySelector('.app');
	var overlay = document.getElementById('panel-overlay');
	if (!app) {
		return;
	}

	var panels = {
		sidebar: {
			toggle: document.getElementById('sidebar-toggle'),
			openClass: 'is-sidebar-open',
			collapsedClass: 'is-sidebar-collapsed'
		},
		info: {
			toggle: document.getElementById('info-panel-toggle'),
			openClass: 'is-info-open',
			collapsedClass: 'is-info-collapsed'
		}
	};

	function isMobile() {
		return MOBILE_QUERY.matches;
	}

	function isExpanded(panel) {
		return isMobile()
			? app.classList.contains(panel.openClass)
			: !app.classList.contains(panel.collapsedClass);
	}

	function syncState() {
		var anyOpen = false;
		Object.keys(panels).forEach(function (key) {
			var panel = panels[key];
			var expanded = isExpanded(panel);
			if (panel.toggle) {
				panel.toggle.setAttribute('aria-expanded', String(expanded));
			}
			if (isMobile() && expanded) {
				anyOpen = true;
			}
		});
		if (overlay) {
			overlay.hidden = !anyOpen;
		}
	}

	// 지도 컨테이너 크기가 바뀌었음을 알린다. (향후 VWorld 지도 리사이즈 대응용)
	function notifyLayoutChange() {
		window.dispatchEvent(new Event('resize'));
	}

	function closeMobilePanels() {
		Object.keys(panels).forEach(function (key) {
			app.classList.remove(panels[key].openClass);
		});
	}

	function togglePanel(key) {
		var panel = panels[key];
		if (isMobile()) {
			var willOpen = !app.classList.contains(panel.openClass);
			closeMobilePanels();
			if (willOpen) {
				app.classList.add(panel.openClass);
			}
		} else {
			app.classList.toggle(panel.collapsedClass);
			notifyLayoutChange();
		}
		syncState();
	}

	Object.keys(panels).forEach(function (key) {
		var toggle = panels[key].toggle;
		if (toggle) {
			toggle.addEventListener('click', function () {
				togglePanel(key);
			});
		}
	});

	if (overlay) {
		overlay.addEventListener('click', function () {
			closeMobilePanels();
			syncState();
		});
	}

	/*
	 * VWorld 지도는 오른쪽 조작 막대가 보이는 동안 document에 키보드 처리기를 붙인다. (방향키: 이동, Home/End: 확대·축소,
	 * PageUp/PageDown·Insert/Delete: 회전) 포커스 위치를 확인하지 않으므로 검색어·제목·반경을 입력할 때 지도가 움직인다.
	 * 앱 안의 입력칸에서 누른 키는 document까지 올라가지 않게 막는다. 글자 편집(기본 동작)은 그대로이고,
	 * Esc(패널 닫기, 측정 취소)는 전달한다. 입력칸 밖(지도, 버튼)에서의 지도 단축키는 영향받지 않는다.
	 */
	function isEditableField(target) {
		return !!target && (/^(input|textarea|select)$/i.test(target.tagName || '') || target.isContentEditable === true);
	}

	function keepKeysInFields(event) {
		if (event.key !== 'Escape' && isEditableField(event.target)) {
			event.stopPropagation();
		}
	}

	app.addEventListener('keydown', keepKeysInFields);
	app.addEventListener('keyup', keepKeysInFields);

	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && isMobile()) {
			closeMobilePanels();
			syncState();
		}
	});

	// 화면 크기 구간이 바뀌면 열린 슬라이드 패널을 닫고 상태를 다시 맞춘다.
	var onBreakpointChange = function () {
		closeMobilePanels();
		syncState();
	};
	if (MOBILE_QUERY.addEventListener) {
		MOBILE_QUERY.addEventListener('change', onBreakpointChange);
	} else {
		MOBILE_QUERY.addListener(onBreakpointChange);
	}

	// 다른 모듈(building-info.js 등)에서 패널을 열 때 사용한다.
	function openPanel(key) {
		var panel = panels[key];
		if (!panel) {
			return;
		}
		if (isMobile()) {
			closeMobilePanels();
			app.classList.add(panel.openClass);
		} else if (app.classList.contains(panel.collapsedClass)) {
			app.classList.remove(panel.collapsedClass);
			notifyLayoutChange();
		}
		syncState();
	}

	// 작은 화면에서 열린 슬라이드 패널을 닫는다. (지도 도구 선택 시 지도를 가리지 않도록 사용)
	function closePanels() {
		if (isMobile()) {
			closeMobilePanels();
			syncState();
		}
	}

	window.gisLayout = {
		openPanel: openPanel,
		closePanels: closePanels,
		isMobile: isMobile
	};

	syncState();
})();
