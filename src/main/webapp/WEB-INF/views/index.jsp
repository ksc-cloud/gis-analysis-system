<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ taglib prefix="c" uri="jakarta.tags.core" %>
<!DOCTYPE html>
<html lang="ko">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title><c:out value="${pageTitle}" default="GIS 3D 지도"/> | <c:out value="${applicationName}"/></title>
	<link rel="stylesheet" href="${pageContext.request.contextPath}/css/main.css">
</head>
<body>
<div class="app">
	<header class="app-header" id="app-header">
		<button type="button" class="panel-toggle" id="sidebar-toggle"
				aria-controls="sidebar" aria-expanded="false" aria-label="메뉴 열기/닫기">
			<span class="panel-toggle__icon" aria-hidden="true">&#9776;</span>
			<span class="panel-toggle__label">메뉴</span>
		</button>

		<div class="app-header__brand">
			<span class="app-header__logo" aria-hidden="true">3D</span>
			<div class="app-header__titles">
				<h1 class="app-header__title"><c:out value="${pageTitle}" default="GIS 3D 지도"/></h1>
				<span class="app-header__subtitle"><c:out value="${applicationName}"/></span>
			</div>
		</div>

		<div class="app-header__actions">
			<c:if test="${not empty message}">
				<p class="status-badge" id="status-message"><c:out value="${message}"/></p>
			</c:if>
			<button type="button" class="panel-toggle" id="info-panel-toggle"
					aria-controls="info-panel" aria-expanded="false" aria-label="정보 패널 열기/닫기">
				<span class="panel-toggle__icon" aria-hidden="true">&#9432;</span>
				<span class="panel-toggle__label">정보</span>
			</button>
		</div>
	</header>

	<aside class="sidebar panel" id="sidebar" aria-label="지도 메뉴">
		<section class="panel-section" aria-labelledby="search-title">
			<h2 class="panel-section__title" id="search-title">지도 검색</h2>
			<form class="search-form" id="map-search-form">
				<label class="visually-hidden" for="map-search-input">주소 또는 건물명</label>
				<input type="search" id="map-search-input" class="search-form__input"
					   placeholder="주소 또는 건물명 검색" disabled>
				<button type="submit" class="search-form__button" disabled>검색</button>
			</form>
			<p class="panel-hint">검색 기능은 준비 중입니다.</p>
		</section>

		<section class="panel-section" aria-labelledby="quick-move-title">
			<h2 class="panel-section__title" id="quick-move-title">빠른 이동</h2>
			<div class="quick-move" id="quick-move">
				<button type="button" class="quick-move__button" id="move-korea" data-move="korea" disabled>대한민국 전체</button>
				<button type="button" class="quick-move__button" id="move-seoul" data-move="seoul" disabled>서울 도심</button>
			</div>
			<p class="panel-hint" id="quick-move-hint">지도가 표시되면 사용할 수 있습니다.</p>
		</section>

		<nav class="panel-section" aria-labelledby="menu-title">
			<h2 class="panel-section__title" id="menu-title">주요 기능</h2>
			<ul class="menu" id="main-menu">
				<li><span class="menu__item menu__item--active" aria-current="page">지도 보기</span></li>
				<li><span class="menu__item" aria-disabled="true">레이어 관리 <em class="badge">준비 중</em></span></li>
				<li><span class="menu__item" aria-disabled="true">건물 정보 조회 <em class="badge">준비 중</em></span></li>
			</ul>
		</nav>

		<nav class="panel-section" aria-labelledby="analysis-title">
			<h2 class="panel-section__title" id="analysis-title">GIS 분석</h2>
			<ul class="menu" id="analysis-menu">
				<li><span class="menu__item" aria-disabled="true">거리 측정 <em class="badge">준비 중</em></span></li>
				<li><span class="menu__item" aria-disabled="true">면적 측정 <em class="badge">준비 중</em></span></li>
				<li><span class="menu__item" aria-disabled="true">반경 분석 <em class="badge">준비 중</em></span></li>
			</ul>
		</nav>
	</aside>

	<main class="map-area" id="map-area">
		<%-- VWorld 3D 지도 컨테이너. VWorld 뷰어가 이 요소 안에 생성된다. --%>
		<div id="map" class="map-container"></div>

		<%-- 작은 화면에서 건물을 선택했을 때 표시하는 안내바 (정보 패널은 자동으로 열지 않는다) --%>
		<div class="selection-bar" id="selection-bar" hidden>
			<span class="selection-bar__text" id="selection-bar-text">건물 선택됨</span>
			<button type="button" class="selection-bar__button" id="selection-bar-open">정보 보기</button>
			<button type="button" class="selection-bar__button selection-bar__button--ghost" id="selection-bar-clear">해제</button>
		</div>

		<div class="map-status" id="map-status" role="status" aria-live="polite"
			 data-state="${vworldEnabled ? 'loading' : 'no-key'}">
			<div class="map-status__box">
				<c:choose>
					<c:when test="${vworldEnabled}">
						<span class="map-status__icon" aria-hidden="true">&#8987;</span>
						<p class="map-status__title" id="map-status-title">3D 지도를 불러오는 중입니다.</p>
						<p class="map-status__text" id="map-status-text">처음 접속할 때는 시간이 걸릴 수 있습니다.</p>
					</c:when>
					<c:otherwise>
						<span class="map-status__icon" aria-hidden="true">&#128273;</span>
						<p class="map-status__title" id="map-status-title">VWorld API 키가 설정되지 않았습니다.</p>
						<p class="map-status__text" id="map-status-text">
							환경변수 <code>VWORLD_API_KEY</code> 또는 프로젝트 루트의
							<code>application-local.properties</code>에 <code>vworld.api-key</code>를 설정한 뒤
							서버를 다시 시작하세요.
						</p>
					</c:otherwise>
				</c:choose>
			</div>
		</div>
	</main>

	<aside class="info-panel panel" id="info-panel" aria-label="건물 정보">
		<section class="panel-section building" id="building-section" data-state="empty" aria-labelledby="building-title">
			<div class="building__header">
				<h2 class="panel-section__title" id="building-title">건물 정보</h2>
				<button type="button" class="building__clear" id="building-clear" hidden>선택 해제</button>
			</div>
			<p class="empty-state" id="building-empty">
				선택된 건물이 없습니다.<br>
				지도에서 건물을 선택하면 정보가 표시됩니다.
			</p>
			<div class="building-status" id="building-status" role="status" aria-live="polite" hidden>
				<p class="building-status__text" id="building-status-text"></p>
				<ul class="building-status__candidates" id="building-candidates" hidden></ul>
				<button type="button" class="building-status__retry" id="building-retry" hidden>다시 조회</button>
			</div>
			<dl class="info-list" id="building-info">
				<div class="info-list__row"><dt>건물명</dt><dd id="info-name">-</dd></div>
				<div class="info-list__row"><dt>도로명 주소</dt><dd id="info-address">-</dd></div>
				<div class="info-list__row"><dt>건물 용도</dt><dd id="info-usage">-</dd></div>
				<div class="info-list__row"><dt>지상층수</dt><dd id="info-floors">-</dd></div>
				<div class="info-list__row"><dt>준공연도</dt><dd id="info-year">-</dd></div>
				<div class="info-list__row"><dt>건물관리번호</dt><dd id="info-bd-mgt-sn">-</dd></div>
				<div class="info-list__row"><dt>3D 모델 ID</dt><dd id="info-model-id">-</dd></div>
				<div class="info-list__row"><dt>클릭 좌표</dt><dd id="info-coord">-</dd></div>
			</dl>
			<p class="panel-hint building__notice" id="building-notice" hidden>
				건물 정보는 클릭한 위치를 포함하는 도로명주소 건물(VWorld LT_C_SPBD)을 조회한 결과입니다.
				3D 모델과 정확히 일치하지 않을 수 있으며, 3D 모델 ID와 건물관리번호는 서로 다른 식별자입니다.
			</p>
		</section>
	</aside>

	<div class="overlay" id="panel-overlay" hidden></div>
</div>
<script src="${pageContext.request.contextPath}/js/main.js"></script>
<c:if test="${vworldEnabled}">
	<%-- VWorld 3D Map API 3.0: 내부에서 $.ajax를 사용하므로 jQuery를 먼저 로드한다. --%>
	<script src="https://code.jquery.com/jquery-3.7.1.min.js"
			integrity="sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=" crossorigin="anonymous"
			onerror="window.gisScriptErrors = (window.gisScriptErrors || []).concat('jquery')"></script>
	<%-- 로더가 document.write로 하위 스크립트를 삽입하므로 async/defer 없이 동기 로딩해야 한다. --%>
	<script src="https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&amp;apiKey=<c:out value='${vworldApiKey}'/>"
			onerror="window.gisScriptErrors = (window.gisScriptErrors || []).concat('vworld')"></script>
	<%-- 지도 준비 이벤트(gis:mapready)를 놓치지 않도록 vworld-map.js보다 먼저 로드한다. --%>
	<script src="${pageContext.request.contextPath}/js/building-info.js"
			data-api-url="${pageContext.request.contextPath}/api/buildings/at"></script>
	<script src="${pageContext.request.contextPath}/js/vworld-map.js"></script>
</c:if>
</body>
</html>
