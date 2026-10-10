/*
 * GIS 3D 지도 - 레이아웃 제어
 * - 넓은 화면: 사이드바/정보 패널을 접고 펼친다.
 * - 작은 화면(900px 이하): 사이드바/정보 패널을 슬라이드 패널로 열고 닫는다.
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

	window.gisLayout = {
		openPanel: openPanel,
		isMobile: isMobile
	};

	syncState();
})();
