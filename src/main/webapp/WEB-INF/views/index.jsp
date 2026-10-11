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
			</div>
		</div>

		<div class="app-header__actions">
			<button type="button" class="panel-toggle" id="info-panel-toggle"
					aria-controls="info-panel" aria-expanded="false" aria-label="정보 패널 열기/닫기">
				<span class="panel-toggle__icon" aria-hidden="true">&#9432;</span>
				<span class="panel-toggle__label">정보</span>
			</button>
		</div>
	</header>

	<aside class="sidebar panel" id="sidebar" aria-label="지도 메뉴">
		<section class="panel-section search" aria-labelledby="search-title">
			<h2 class="panel-section__title" id="search-title">지도 검색</h2>
			<form class="search-form" id="map-search-form" novalidate>
				<label class="visually-hidden" for="map-search-type">검색 유형</label>
				<select id="map-search-type" class="search-form__type" disabled>
					<option value="place">장소·건물명</option>
					<option value="road">도로명 주소</option>
					<option value="parcel">지번 주소</option>
				</select>
				<div class="search-form__row">
					<label class="visually-hidden" for="map-search-input">검색어</label>
					<input type="search" id="map-search-input" class="search-form__input"
						   placeholder="예: 서울특별시청, 세종대로 110" autocomplete="off" disabled>
					<button type="submit" class="search-form__button" id="map-search-button" disabled>검색</button>
				</div>
			</form>
			<p class="panel-hint" id="map-search-hint">지도가 표시되면 사용할 수 있습니다.</p>
			<p class="search__status" id="map-search-status" role="status" aria-live="polite" hidden></p>
			<ol class="search__results" id="map-search-results"></ol>
			<nav class="search__pager" id="map-search-pager" aria-label="검색 결과 페이지" hidden>
				<button type="button" class="tool-bar__button" id="map-search-prev">이전</button>
				<span class="search__page" id="map-search-page"></span>
				<button type="button" class="tool-bar__button" id="map-search-next">다음</button>
			</nav>
			<div class="search__selected" id="map-search-selected" hidden>
				<p class="search__selected-label">검색 위치</p>
				<p class="search__selected-text" id="map-search-selected-text"></p>
				<div class="search__selected-actions">
					<button type="button" class="tool-bar__button tool-bar__button--primary" id="map-search-radius">이 위치로 반경 분석</button>
					<button type="button" class="tool-bar__button" id="map-search-clear">검색 위치 지우기</button>
				</div>
			</div>
		</section>

		<section class="panel-section" aria-labelledby="quick-move-title">
			<h2 class="panel-section__title" id="quick-move-title">빠른 이동</h2>
			<div class="quick-move" id="quick-move">
				<button type="button" class="quick-move__button" id="move-korea" data-move="korea" disabled>대한민국 전체</button>
				<button type="button" class="quick-move__button" id="move-seoul" data-move="seoul" disabled>서울 도심</button>
			</div>
			<p class="panel-hint" id="quick-move-hint">지도가 표시되면 사용할 수 있습니다.</p>
		</section>

		<section class="panel-section" aria-labelledby="tools-title">
			<h2 class="panel-section__title" id="tools-title">지도 도구</h2>
			<div class="map-tools" id="map-tools" role="group" aria-label="지도 도구 모드">
				<button type="button" class="map-tools__button is-active" data-mode="select" aria-pressed="true" disabled>건물 선택</button>
				<button type="button" class="map-tools__button" data-mode="distance" aria-pressed="false" disabled>거리 측정</button>
				<button type="button" class="map-tools__button" data-mode="area" aria-pressed="false" disabled>면적 측정</button>
				<button type="button" class="map-tools__button" data-mode="coord" aria-pressed="false" disabled>좌표 조회</button>
			</div>
			<button type="button" class="map-tools__reset" id="measure-reset" disabled>측정 결과 초기화</button>
			<p class="panel-hint" id="map-tools-hint">지도가 표시되면 사용할 수 있습니다.</p>
		</section>

		<section class="panel-section" aria-labelledby="layers-title">
			<h2 class="panel-section__title" id="layers-title">레이어</h2>
			<ul class="layer-list" id="layer-list">
				<li><label class="layer-list__item"><input type="checkbox" data-layer="facility_build" checked disabled> 3D 건물</label></li>
				<li><label class="layer-list__item"><input type="checkbox" data-layer="poi_base" checked disabled> 지명</label></li>
				<li><label class="layer-list__item"><input type="checkbox" data-layer="hybrid_bound" checked disabled> 행정경계</label></li>
			</ul>
			<p class="panel-hint" id="layer-hint">지도가 표시되면 사용할 수 있습니다.</p>
		</section>

		<nav class="panel-section" aria-labelledby="analysis-title">
			<h2 class="panel-section__title" id="analysis-title">GIS 분석</h2>
			<div class="map-tools" id="analysis-menu" role="group" aria-label="GIS 분석 모드">
				<button type="button" class="map-tools__button" data-mode="radius" aria-pressed="false" disabled>반경 분석</button>
			</div>
			<p class="panel-hint" id="analysis-hint">지도에서 중심점을 고르면 반경 안의 건물을 조회합니다.</p>
		</nav>
	</aside>

	<main class="map-area" id="map-area">
		<%-- VWorld 3D 지도 컨테이너. VWorld 뷰어가 이 요소 안에 생성된다. --%>
		<div id="map" class="map-container"></div>

		<%-- 거리/면적 측정, 좌표 조회 모드에서만 표시하는 지도 상단 도구 안내바 --%>
		<div class="tool-bar" id="tool-bar" data-mode="select" hidden>
			<div class="tool-bar__head">
				<strong class="tool-bar__title" id="tool-bar-title"></strong>
				<span class="tool-bar__guide" id="tool-bar-guide"></span>
				<%-- 패널을 접었을 때만 보이는 현재 모드의 요약 (map-tools.js, 반경 분석 문구는 map-analysis.js가 전달) --%>
				<span class="tool-bar__collapsed-summary" id="tool-bar-summary" role="status" aria-live="polite" hidden></span>
				<%-- 접기/펼치기: 거리·면적·좌표·반경 모드 공통 (건물 선택 모드에서는 패널 자체를 표시하지 않음) --%>
				<button type="button" class="tool-bar__toggle" id="tool-bar-toggle" aria-expanded="true"
						aria-controls="tool-bar-body" aria-label="지도 도구 패널 접기">접기 &#9650;</button>
			</div>
			<div class="tool-bar__body" id="tool-bar-body">
			<p class="tool-bar__notice" id="tool-bar-notice"></p>
			<div class="tool-bar__coord" id="coord-result" hidden>
				<output class="tool-bar__coord-text" id="coord-text"></output>
				<button type="button" class="tool-bar__button" id="coord-copy">복사</button>
			</div>
			<%-- 반경 분석 모드에서만 표시 (map-analysis.js) --%>
			<div class="radius-controls" id="radius-controls" hidden>
				<p class="radius-controls__center" id="radius-center">중심점: 선택되지 않음</p>
				<div class="radius-controls__options" role="group" aria-label="분석 반경">
					<button type="button" class="tool-bar__button" data-radius="100" aria-pressed="false">100m</button>
					<button type="button" class="tool-bar__button" data-radius="500" aria-pressed="true">500m</button>
					<button type="button" class="tool-bar__button" data-radius="1000" aria-pressed="false">1km</button>
					<label class="radius-controls__custom">
						<span class="visually-hidden">직접 입력 (50~1000m)</span>
						<input type="number" id="radius-custom" min="50" max="1000" step="1" inputmode="numeric"
							   placeholder="직접 입력(m)">
					</label>
					<button type="button" class="tool-bar__button" id="radius-custom-apply">적용</button>
				</div>
				<p class="radius-controls__summary" id="radius-summary" role="status" aria-live="polite"></p>
				<div class="tool-bar__actions">
					<button type="button" class="tool-bar__button tool-bar__button--primary" id="radius-run" disabled>분석 실행</button>
					<button type="button" class="tool-bar__button" id="radius-reset" disabled>분석 초기화</button>
					<button type="button" class="tool-bar__button" id="radius-open-results" hidden>결과 보기</button>
				</div>
			</div>
			<p class="tool-bar__message" id="tool-bar-message" role="status" aria-live="polite"></p>
			<div class="tool-bar__actions">
				<button type="button" class="tool-bar__button" id="tool-complete" hidden>완료 (실험적)</button>
				<button type="button" class="tool-bar__button" id="tool-restart" hidden>새 측정</button>
				<button type="button" class="tool-bar__button" id="tool-cancel" hidden>그리기 취소</button>
				<button type="button" class="tool-bar__button" id="tool-reset" hidden>결과 초기화</button>
				<button type="button" class="tool-bar__button tool-bar__button--primary" id="tool-exit">건물 선택으로</button>
			</div>
			</div>
		</div>

		<%-- 작은 화면에서 건물을 선택했을 때 표시하는 안내바 (정보 패널은 자동으로 열지 않는다) --%>
		<div class="selection-bar" id="selection-bar" hidden>
			<span class="selection-bar__text" id="selection-bar-text">건물 선택됨</span>
			<button type="button" class="selection-bar__button" id="selection-bar-open">정보 보기</button>
			<button type="button" class="selection-bar__button selection-bar__button--ghost" id="selection-bar-clear">해제</button>
		</div>

		<%-- 저장된 분석을 지도에 다시 표시하는 동안 보이는 안내 막대 (실시간 결과와 구분) --%>
		<div class="saved-bar" id="saved-analysis-bar" hidden>
			<span class="saved-bar__badge">저장된 분석</span>
			<span class="saved-bar__title" id="saved-analysis-bar-title"></span>
			<button type="button" class="saved-bar__button" id="saved-analysis-bar-open">결과 보기</button>
			<button type="button" class="saved-bar__button saved-bar__button--ghost" id="saved-analysis-bar-close">표시 해제</button>
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

	<aside class="info-panel panel" id="info-panel" aria-label="건물 정보 및 분석 결과">
		<div class="info-tabs" id="info-tabs" role="tablist" aria-label="정보 패널">
			<button type="button" class="info-tabs__tab" id="tab-building" role="tab" aria-selected="true"
					aria-controls="building-section">건물 정보</button>
			<button type="button" class="info-tabs__tab" id="tab-analysis" role="tab" aria-selected="false"
					aria-controls="analysis-section" tabindex="-1">반경 분석</button>
			<button type="button" class="info-tabs__tab" id="tab-history" role="tab" aria-selected="false"
					aria-controls="history-section" tabindex="-1">분석 이력</button>
			<button type="button" class="info-tabs__tab" id="tab-spatial" role="tab" aria-selected="false"
					aria-controls="spatial-section" tabindex="-1">공간 분석</button>
		</div>
		<section class="panel-section building" id="building-section" data-state="empty" role="tabpanel"
				 aria-labelledby="building-title">
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

		<section class="panel-section analysis" id="analysis-section" data-state="empty" role="tabpanel"
				 aria-labelledby="analysis-title" hidden>
			<div class="building__header">
				<h2 class="panel-section__title" id="analysis-title">반경 분석</h2>
				<button type="button" class="building__clear" id="analysis-clear" hidden>분석 초기화</button>
			</div>
			<p class="empty-state" id="analysis-empty">
				분석 결과가 없습니다.<br>
				"반경 분석" 모드에서 중심점을 고르고 분석을 실행하세요.
			</p>
			<p class="analysis__status" id="analysis-status" role="status" aria-live="polite" hidden></p>
			<div class="analysis__result" id="analysis-result" hidden>
				<p class="analysis__kind" id="analysis-kind" hidden></p>
				<div class="analysis__saved-banner" id="analysis-saved-banner" hidden>
					<p class="analysis__saved-label">저장된 분석</p>
					<p class="analysis__saved-title" id="analysis-saved-title"></p>
					<p class="analysis__saved-meta" id="analysis-saved-meta"></p>
					<div class="analysis__saved-actions">
						<button type="button" class="tool-bar__button" id="analysis-saved-rerun">같은 범위로 다시 분석</button>
						<button type="button" class="tool-bar__button" id="analysis-saved-close">표시 해제</button>
					</div>
				</div>
				<form class="analysis-save" id="analysis-save" novalidate hidden>
					<h3 class="analysis__subtitle">분석 결과 저장</h3>
					<label class="analysis-save__label" for="analysis-save-title">
						제목 <span class="analysis-save__count" id="analysis-save-count">0 / 100</span>
					</label>
					<div class="analysis-save__row">
						<input type="text" id="analysis-save-title" class="analysis-save__input" autocomplete="off"
							   placeholder="예: 서울시청 반경 500m">
						<button type="submit" class="tool-bar__button tool-bar__button--primary"
								id="analysis-save-button">분석 결과 저장</button>
					</div>
					<p class="panel-hint" id="analysis-save-hint">
						분석 후 30분 안에 저장할 수 있습니다. 서버가 다시 시작되면 분석을 다시 실행해야 합니다.
					</p>
					<p class="analysis-save__status" id="analysis-save-status" role="status" aria-live="polite" hidden></p>
					<button type="button" class="building-status__retry" id="analysis-save-open-history" hidden>분석 이력에서 보기</button>
				</form>
				<dl class="info-list">
					<div class="info-list__row"><dt>중심점</dt><dd id="analysis-center">-</dd></div>
					<div class="info-list__row"><dt>분석 반경</dt><dd id="analysis-radius">-</dd></div>
					<div class="info-list__row"><dt>판정 기준</dt><dd id="analysis-criterion">-</dd></div>
					<div class="info-list__row"><dt>조회된 건물</dt><dd id="analysis-count">-</dd></div>
					<div class="info-list__row"><dt>완전 포함</dt><dd id="analysis-inside">-</dd></div>
					<div class="info-list__row"><dt>경계 걸침</dt><dd id="analysis-partial">-</dd></div>
					<div class="info-list__row"><dt>VWorld 조회</dt><dd id="analysis-fetched">-</dd></div>
				</dl>
				<div class="analysis__completeness" id="analysis-completeness"></div>
				<h3 class="analysis__subtitle">지상층수 분포</h3>
				<ul class="analysis__floors" id="analysis-floors"></ul>
				<p class="panel-hint" id="analysis-floors-note"></p>
				<h3 class="analysis__subtitle">건물 목록 <span class="analysis__subtitle-note">(가까운 순)</span></h3>
				<p class="panel-hint" id="analysis-map-note"></p>
				<ol class="analysis__list" id="analysis-list"></ol>
				<button type="button" class="building-status__retry" id="analysis-more" hidden>더 보기</button>
				<p class="panel-hint" id="analysis-notice">
					거리는 중심점에서 건물 다각형까지의 최단 수평거리이며 지형을 반영한 실제 이동 거리가 아닙니다.
					건물 다각형의 내부 구멍은 판정에는 반영하지만 지도에는 표시하지 못합니다.
					3D 건물에 가려 바닥 도형이 잘 보이지 않으면 레이어에서 "3D 건물"을 끄세요.
				</p>
				<p class="panel-hint" id="analysis-source"></p>
			</div>
		</section>

		<section class="panel-section history" id="history-section" data-state="idle" role="tabpanel"
				 aria-labelledby="history-title" hidden>
			<div class="building__header">
				<h2 class="panel-section__title" id="history-title">분석 이력</h2>
				<button type="button" class="building__clear" id="history-refresh">새로 고침</button>
			</div>
			<div class="history__toolbar">
				<label class="history__sort-label" for="history-sort">정렬</label>
				<select id="history-sort" class="history__sort">
					<option value="SAVED_DESC">최근 저장순</option>
					<option value="SAVED_ASC">오래된 저장순</option>
					<option value="TITLE_ASC">제목순</option>
					<option value="BUILDINGS_DESC">건물 많은 순</option>
				</select>
				<span class="history__total" id="history-total"></span>
			</div>
			<p class="history__status" id="history-status" role="status" aria-live="polite" hidden></p>
			<button type="button" class="building-status__retry" id="history-retry" hidden>다시 시도</button>
			<p class="empty-state" id="history-empty" hidden>
				저장된 분석 이력이 없습니다.<br>
				반경 분석 결과에서 "분석 결과 저장"을 누르세요.
			</p>
			<ul class="history__list" id="history-list"></ul>
			<nav class="history__pager" id="history-pager" aria-label="분석 이력 페이지" hidden>
				<button type="button" class="tool-bar__button" id="history-prev">이전</button>
				<span class="history__page" id="history-page"></span>
				<button type="button" class="tool-bar__button" id="history-next">다음</button>
			</nav>
			<p class="panel-hint" id="history-notice">
				저장된 분석은 저장 시점의 VWorld 데이터입니다. "지도에서 보기"는 VWorld를 다시 조회하지 않습니다.
			</p>
		</section>

		<%-- 공간 분석: 공간 통계(8-6A). 격자와 비교는 다음 단계에서 제공한다. (spatial-dashboard.js) --%>
		<section class="panel-section spatial" id="spatial-section" data-state="empty" role="tabpanel"
				 aria-labelledby="spatial-title" hidden>
			<div class="building__header">
				<h2 class="panel-section__title" id="spatial-title">공간 분석</h2>
			</div>
			<div class="spatial-views" role="group" aria-label="공간 분석 화면">
				<button type="button" class="spatial-views__button" aria-pressed="true">통계</button>
				<button type="button" class="spatial-views__button" aria-pressed="false" disabled
						title="다음 단계에서 제공할 예정입니다.">격자 <span class="spatial-views__soon">준비 중</span></button>
				<button type="button" class="spatial-views__button" aria-pressed="false" disabled
						title="다음 단계에서 제공할 예정입니다.">비교 <span class="spatial-views__soon">준비 중</span></button>
			</div>
			<div class="spatial-service" id="spatial-service" data-state="checking">
				<div class="spatial-service__row">
					<span class="spatial-service__label">분석 서버</span>
					<span class="spatial-service__badge" id="spatial-service-badge">확인 중</span>
					<button type="button" class="building__clear" id="spatial-service-recheck">다시 확인</button>
				</div>
				<p class="spatial-service__text" id="spatial-service-text" role="status" aria-live="polite">
					공간 분석 서버 상태를 확인하고 있습니다...
				</p>
			</div>
			<p class="empty-state" id="spatial-empty">
				분석 결과가 없습니다.<br>
				반경 분석을 실행하거나 분석 이력에서 저장된 분석을 열면 공간 통계를 계산합니다.
			</p>
			<p class="spatial__status" id="spatial-status" role="status" aria-live="polite" hidden></p>
			<button type="button" class="building-status__retry" id="spatial-retry" hidden>다시 시도</button>
			<div class="spatial__result" id="spatial-result" hidden>
				<p class="spatial__source" id="spatial-source"></p>
				<div class="analysis__completeness" id="spatial-completeness"></div>
				<div class="spatial-kpis" id="spatial-kpis"></div>
				<h3 class="analysis__subtitle" id="spatial-warnings-title" hidden>분석 경고</h3>
				<ul class="spatial__warnings" id="spatial-warnings" hidden></ul>
				<p class="panel-hint" id="spatial-notice">
					면적은 VWorld 도로명주소 건물 도형의 수평 면적(m²)이며 건축물대장의 건축면적과 다를 수 있습니다.
					점유율은 반경 원 면적에 대한 건물 점유 면적의 비율(%)입니다.
				</p>
			</div>
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
	<script src="${pageContext.request.contextPath}/js/map-analysis-renderer.js"></script>
	<script src="${pageContext.request.contextPath}/js/map-analysis.js"
			data-api-url="${pageContext.request.contextPath}/api/buildings/nearby"></script>
	<%-- 분석 결과 저장, 분석 이력(목록/다시 보기/삭제): /api/analyses 통신 담당 --%>
	<script src="${pageContext.request.contextPath}/js/map-history.js"
			data-api-url="${pageContext.request.contextPath}/api/analyses"></script>
	<%-- 공간 분석(공간 통계, 분석 서버 상태): Java의 /api/spatial-analysis, /api/analysis-snapshots, /api/analyses/{id}/statistics만
		 호출한다. gis:analysisresult와 gis:analysissaved를 놓치지 않도록 map-history.js 다음, vworld-map.js 전에 로드한다. --%>
	<script src="${pageContext.request.contextPath}/js/spatial-api.js"></script>
	<script src="${pageContext.request.contextPath}/js/spatial-dashboard.js"
			data-api-base="${pageContext.request.contextPath}/api"></script>
	<%-- 지도 검색: /api/search 통신, 검색 위치 마커, "이 위치로 반경 분석"(window.gisAnalysis.startAt) --%>
	<script src="${pageContext.request.contextPath}/js/map-search.js"
			data-api-url="${pageContext.request.contextPath}/api/search"></script>
	<script src="${pageContext.request.contextPath}/js/map-tools.js"></script>
	<script src="${pageContext.request.contextPath}/js/map-layers.js"></script>
	<script src="${pageContext.request.contextPath}/js/vworld-map.js"></script>
</c:if>
</body>
</html>
