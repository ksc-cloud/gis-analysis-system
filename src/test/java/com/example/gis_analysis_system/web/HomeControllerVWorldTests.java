package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Renders the page with a fake VWorld key. Only the server-side HTML is checked; VWorld is not called.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT, properties = "vworld.api-key= fake-key&x=<1> ")
class HomeControllerVWorldTests {

	private final HttpClient httpClient = HttpClient.newHttpClient();

	@LocalServerPort
	private int port;

	@Test
	void homeLoadsVWorldScriptsInOrderWhenApiKeyIsSet() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body)
			.contains("<h1 class=\"app-header__title\">GIS 3D 지도</h1>")
			.contains("id=\"map\"")
			.contains("data-state=\"loading\"")
			.contains("id=\"move-seoul\"")
			.doesNotContain("VWorld API 키가 설정되지 않았습니다.")
			// The key is trimmed and URL-encoded, so it cannot break out of the script URL.
			.contains("src=\"https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&amp;apiKey=fake-key%26x%3D%3C1%3E\"")
			.doesNotContain("<1>");

		int jquery = body.indexOf("https://code.jquery.com/jquery-3.7.1.min.js");
		int loader = body.indexOf("https://map.vworld.kr/js/webglMapInit.js.do");
		int buildingScript = body.indexOf("/js/building-info.js");
		int rendererScript = body.indexOf("/js/map-analysis-renderer.js");
		int analysisScript = body.indexOf("/js/map-analysis.js");
		int toolsScript = body.indexOf("/js/map-tools.js");
		int layersScript = body.indexOf("/js/map-layers.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		assertThat(jquery).isPositive();
		assertThat(loader).isGreaterThan(jquery);
		// building-info.js must be loaded before vworld-map.js so it does not miss the gis:mapready event.
		assertThat(buildingScript).isGreaterThan(loader);
		// All modules listening for gis:mapready must be loaded before vworld-map.js.
		assertThat(rendererScript).isGreaterThan(buildingScript);
		// map-tools.js checks window.gisAnalysisRenderer when enabling the radius mode button.
		assertThat(analysisScript).isGreaterThan(rendererScript);
		assertThat(toolsScript).isGreaterThan(analysisScript);
		assertThat(layersScript).isGreaterThan(toolsScript);
		assertThat(mapScript).isGreaterThan(layersScript);
		assertThat(body).contains("data-api-url=\"/api/buildings/at\"")
			.contains("data-api-url=\"/api/buildings/nearby\"");
	}

	@Test
	void homeLoadsTheHistoryScriptAfterTheAnalysisScript() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		int analysisScript = body.indexOf("/js/map-analysis.js");
		int historyScript = body.indexOf("/js/map-history.js");
		int toolsScript = body.indexOf("/js/map-tools.js");
		// map-history.js uses window.gisAnalysis, and must not miss the first gis:analysisresult event.
		assertThat(historyScript).isGreaterThan(analysisScript);
		assertThat(toolsScript).isGreaterThan(historyScript);
		assertThat(body).contains("data-api-url=\"/api/analyses\"")
			.contains("id=\"tab-history\"")
			.contains("aria-controls=\"history-section\"")
			.contains("id=\"history-section\"")
			.contains("id=\"history-list\"")
			.contains("id=\"history-sort\"")
			.contains("value=\"BUILDINGS_DESC\"")
			.contains("id=\"history-pager\"")
			.contains("id=\"analysis-save\"")
			.contains("id=\"analysis-save-title\"")
			.contains("id=\"analysis-save-button\"")
			.contains("id=\"analysis-kind\"")
			.contains("id=\"analysis-saved-banner\"")
			.contains("id=\"saved-analysis-bar\"");
	}

	@Test
	void homeRendersTheSearchFormAndLoadsTheSearchScriptBeforeTheMap() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		int historyScript = body.indexOf("/js/map-history.js");
		int searchScript = body.indexOf("/js/map-search.js");
		int toolsScript = body.indexOf("/js/map-tools.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		// map-search.js uses window.gisAnalysis.startAt and must not miss gis:mapready.
		assertThat(searchScript).isGreaterThan(historyScript);
		assertThat(toolsScript).isGreaterThan(searchScript);
		assertThat(mapScript).isGreaterThan(searchScript);
		assertThat(body).contains("data-api-url=\"/api/search\"")
			.contains("id=\"map-search-type\"")
			.contains("<option value=\"place\">장소·건물명</option>")
			.contains("<option value=\"road\">도로명 주소</option>")
			.contains("<option value=\"parcel\">지번 주소</option>")
			.contains("id=\"map-search-results\"")
			.contains("id=\"map-search-pager\"")
			.contains("id=\"map-search-radius\"")
			.contains("id=\"map-search-clear\"")
			.doesNotContain("검색 기능은 준비 중입니다.");
	}

	@Test
	void homeRendersTheToolBarToggleWithAccessibilityAttributes() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body).contains("id=\"tool-bar-toggle\" aria-expanded=\"true\"")
			.contains("aria-controls=\"tool-bar-body\" aria-label=\"지도 도구 패널 접기\"")
			.contains("id=\"tool-bar-summary\" role=\"status\" aria-live=\"polite\" hidden")
			// The default mode (building selection) is shown as active before the map is ready.
			.contains("class=\"map-tools__button is-active\" data-mode=\"select\" aria-pressed=\"true\"")
			.contains("class=\"map-tools__button\" data-mode=\"distance\" aria-pressed=\"false\"");
		// The title row stays visible; only the body (notice, radius controls, message, actions) is collapsed.
		int title = body.indexOf("id=\"tool-bar-title\"");
		int toolBarBody = body.indexOf("id=\"tool-bar-body\"");
		assertThat(title).isLessThan(toolBarBody);
		assertThat(toolBarBody).isLessThan(body.indexOf("id=\"radius-controls\""));
		assertThat(toolBarBody).isLessThan(body.indexOf("id=\"radius-run\""));
	}

	@Test
	void homeRendersMapToolsAndLayers() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body)
			.contains("data-mode=\"select\" aria-pressed=\"true\"")
			.contains("data-mode=\"distance\"")
			.contains("data-mode=\"area\"")
			.contains("data-mode=\"coord\"")
			.contains("id=\"measure-reset\"")
			.contains("id=\"tool-bar\"")
			.contains("id=\"coord-copy\"")
			.contains("id=\"tool-complete\"")
			.contains("data-layer=\"facility_build\"")
			.contains("data-layer=\"poi_base\"")
			.contains("data-layer=\"hybrid_bound\"")
			// Features implemented in this stage are no longer listed as "준비 중".
			.doesNotContain("거리 측정 <em class=\"badge\">준비 중</em>")
			.doesNotContain("면적 측정 <em class=\"badge\">준비 중</em>")
			.doesNotContain("레이어 관리 <em class=\"badge\">준비 중</em>")
			.doesNotContain("반경 분석 <em class=\"badge\">준비 중</em>")
			.contains("data-mode=\"radius\" aria-pressed=\"false\" disabled")
			.contains("id=\"radius-controls\"")
			.contains("data-radius=\"100\"")
			.contains("data-radius=\"500\"")
			.contains("data-radius=\"1000\"")
			.contains("id=\"radius-custom\"")
			.contains("id=\"tab-building\"")
			.contains("id=\"tab-analysis\"")
			.contains("id=\"analysis-section\"")
			.contains("id=\"radius-open-results\"");
	}

	@Test
	void homeRendersTheSpatialAnalysisTabAndLoadsItsScriptsAfterTheHistoryScript() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body).contains("id=\"tab-spatial\" role=\"tab\" aria-selected=\"false\"")
			.contains("aria-controls=\"spatial-section\" tabindex=\"-1\">공간 분석</button>")
			.contains("id=\"spatial-section\" data-state=\"empty\" role=\"tabpanel\"")
			.contains("id=\"spatial-service\" data-state=\"checking\"")
			.contains("id=\"spatial-service-badge\">확인 중</span>")
			.contains("id=\"spatial-service-recheck\">다시 확인</button>")
			.contains("id=\"spatial-empty\"")
			.contains("id=\"spatial-status\" role=\"status\" aria-live=\"polite\" hidden")
			.contains("id=\"spatial-retry\" hidden")
			.contains("id=\"spatial-result\" hidden")
			.contains("id=\"spatial-kpis\"")
			.contains("id=\"spatial-completeness\"")
			.contains("id=\"spatial-warnings\" hidden")
			.contains("id=\"spatial-view-button-stats\" data-view=\"stats\"")
			.contains("aria-pressed=\"true\" aria-controls=\"spatial-view-stats\">통계</button>")
			.contains("id=\"spatial-view-stats\"")
			.contains("data-api-base=\"/api\"");
		// The grid (8-6B) and comparison (8-6C) views are both enabled.
		assertThat(body).doesNotContain("class=\"spatial-views__button\" aria-pressed=\"false\" disabled")
			.doesNotContain("spatial-views__soon")
			.contains("id=\"spatial-view-button-grid\" data-view=\"grid\"")
			.contains("aria-pressed=\"false\" aria-controls=\"spatial-view-grid\">격자</button>")
			.contains("id=\"spatial-view-button-compare\" data-view=\"compare\"")
			.contains("aria-pressed=\"false\" aria-controls=\"spatial-view-compare\">비교</button>")
			.doesNotContain(">비교 <span class=\"spatial-views__soon\">");

		int analysisScript = body.indexOf("/js/map-analysis.js");
		int historyScript = body.indexOf("/js/map-history.js");
		int apiScript = body.indexOf("/js/spatial-api.js");
		int dashboardScript = body.indexOf("/js/spatial-dashboard.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		// spatial-dashboard.js uses window.gisSpatialApi and window.gisAnalysis, and must not miss
		// gis:analysisresult / gis:analysissaved, so it follows the analysis and history scripts.
		assertThat(historyScript).isGreaterThan(analysisScript);
		assertThat(apiScript).isGreaterThan(historyScript);
		assertThat(dashboardScript).isGreaterThan(apiScript);
		assertThat(mapScript).isGreaterThan(dashboardScript);
		// The browser only talks to Java: no Python address, internal path or token header on the page.
		assertThat(body).doesNotContain("8001").doesNotContain("/internal/").doesNotContain("X-Internal-Token")
			.doesNotContain("ANALYSIS_INTERNAL_TOKEN");
	}

	@Test
	void homeRendersTheComparisonViewAndHistorySelectionAndLoadsTheCompareScriptLast() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body).contains("id=\"history-compare\" hidden")
			.contains("id=\"history-compare-text\" role=\"status\" aria-live=\"polite\"")
			.contains("id=\"history-compare-run\" disabled>선택한 2건 비교</button>")
			.contains("id=\"history-compare-clear\">선택 해제</button>")
			.contains("id=\"spatial-view-compare\" data-state=\"empty\" hidden")
			.contains("id=\"compare-empty\"")
			.contains("id=\"compare-run\" disabled>선택한 2건 비교</button>")
			.contains("id=\"compare-include-unchanged\"")
			.contains("id=\"compare-status\" role=\"status\" aria-live=\"polite\" hidden")
			.contains("id=\"compare-result\" hidden")
			.contains("id=\"compare-basis\"")
			.contains("id=\"compare-metrics\"")
			.contains("id=\"compare-lists\"")
			.contains("id=\"compare-notes\"");
		// The history list must come after the selection bar inside the history tab.
		assertThat(body.indexOf("id=\"history-compare\"")).isLessThan(body.indexOf("id=\"history-list\""))
			.isGreaterThan(body.indexOf("id=\"history-section\""));

		int historyScript = body.indexOf("/js/map-history.js");
		int dashboardScript = body.indexOf("/js/spatial-dashboard.js");
		int compareScript = body.indexOf("/js/spatial-compare.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		// spatial-compare.js reads window.gisSpatialDashboard for the service state and exposes window.gisCompare,
		// which map-history.js uses when it draws the list.
		assertThat(dashboardScript).isGreaterThan(historyScript);
		assertThat(compareScript).isGreaterThan(dashboardScript);
		assertThat(mapScript).isGreaterThan(compareScript);
		assertThat(body.substring(compareScript - 120, compareScript + 120)).contains("data-api-base=\"/api\"");
	}

	@Test
	void homeRendersTheGridViewAndLoadsTheGridScriptsBeforeTheMap() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body).contains("id=\"spatial-view-grid\" data-state=\"off\" hidden")
			.contains("id=\"grid-empty\"")
			.contains("<input type=\"checkbox\" id=\"grid-display\"> 지도에 격자 표시")
			.contains("id=\"grid-size-50\" data-cell-size=\"50\" aria-pressed=\"false\">50m</button>")
			.contains("id=\"grid-size-100\" data-cell-size=\"100\" aria-pressed=\"true\">100m</button>")
			.contains("id=\"grid-size-200\" data-cell-size=\"200\" aria-pressed=\"false\">200m</button>")
			.contains("<input type=\"checkbox\" id=\"grid-exclude-empty\" checked> 빈 격자 숨기기")
			.contains("id=\"grid-status\" role=\"status\" aria-live=\"polite\" hidden")
			.contains("id=\"grid-retry\" hidden")
			.contains("id=\"grid-summary\" hidden")
			.contains("id=\"grid-notices\" hidden")
			.contains("id=\"grid-detail\" hidden")
			.contains("id=\"grid-legend\"");
		// The grid view sits between the statistics and comparison views.
		assertThat(body.indexOf("id=\"spatial-view-grid\"")).isGreaterThan(body.indexOf("id=\"spatial-view-stats\""))
			.isLessThan(body.indexOf("id=\"spatial-view-compare\""));

		int compareScript = body.indexOf("/js/spatial-compare.js");
		int rendererScript = body.indexOf("/js/spatial-grid-renderer.js");
		int gridScript = body.indexOf("/js/spatial-grid.js");
		int toolsScript = body.indexOf("/js/map-tools.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		// spatial-grid.js uses window.gisCompare (view switch), window.gisGridRenderer/gisGridModel, and the renderer
		// connects to the map on gis:mapready, so both come after spatial-compare.js and before vworld-map.js.
		assertThat(rendererScript).isGreaterThan(compareScript);
		assertThat(gridScript).isGreaterThan(rendererScript);
		assertThat(toolsScript).isGreaterThan(gridScript);
		assertThat(mapScript).isGreaterThan(gridScript);
		assertThat(body.substring(gridScript - 120, gridScript + 120)).contains("data-api-base=\"/api\"");
	}

	@Test
	void homeRendersTheHotspotViewAndLoadsTheHotspotScriptAfterTheGridAndBeforeTheMap() throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + "/")).build();
		String body = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body();

		assertThat(body).contains("id=\"spatial-view-button-hotspot\" data-view=\"hotspot\"")
			.contains("aria-pressed=\"false\" aria-controls=\"spatial-view-hotspot\">핫스팟</button>")
			.contains("id=\"spatial-view-hotspot\" data-state=\"empty\" aria-busy=\"false\" hidden")
			.contains("id=\"hotspot-empty\"")
			.contains("role=\"group\" aria-label=\"핫스팟 셀 크기\"")
			.contains("id=\"hotspot-size-50\" data-cell-size=\"50\" aria-pressed=\"false\">50m</button>")
			.contains("id=\"hotspot-size-100\" data-cell-size=\"100\" aria-pressed=\"true\">100m</button>")
			.contains("id=\"hotspot-size-200\" data-cell-size=\"200\" aria-pressed=\"false\">200m</button>")
			.contains("id=\"hotspot-run\" disabled>핫스팟 분석 실행</button>")
			.contains("id=\"hotspot-clear\" disabled>지도에서 지우기</button>")
			.contains("id=\"hotspot-status\" role=\"status\" aria-live=\"polite\" hidden")
			.contains("id=\"hotspot-retry\" hidden")
			.contains("id=\"hotspot-notice\" hidden")
			.contains("id=\"hotspot-result\" hidden")
			.contains("id=\"hotspot-moran\" aria-labelledby=\"hotspot-moran-title\" hidden")
			.contains("id=\"hotspot-detail\" hidden")
			.contains("id=\"hotspot-legend\"")
			.contains("id=\"hotspot-legend-untested\"")
			.contains("id=\"hotspot-limitations\" hidden");
		// Buttons and panels in the view order: statistics, grid, hotspot, comparison.
		assertThat(body.indexOf("id=\"spatial-view-button-hotspot\""))
			.isGreaterThan(body.indexOf("id=\"spatial-view-button-grid\""))
			.isLessThan(body.indexOf("id=\"spatial-view-button-compare\""));
		assertThat(body.indexOf("id=\"spatial-view-hotspot\"")).isGreaterThan(body.indexOf("id=\"spatial-view-grid\""))
			.isLessThan(body.indexOf("id=\"spatial-view-compare\""));

		int vworldLoader = body.indexOf("webglMapInit.js.do");
		int analysisScript = body.indexOf("/js/map-analysis-renderer.js");
		int historyScript = body.indexOf("/js/map-history.js");
		int apiScript = body.indexOf("/js/spatial-api.js");
		int viewsScript = body.indexOf("/js/spatial-views.js");
		int dashboardScript = body.indexOf("/js/spatial-dashboard.js");
		int rendererScript = body.indexOf("/js/spatial-grid-renderer.js");
		int gridScript = body.indexOf("/js/spatial-grid.js");
		int hotspotScript = body.indexOf("/js/spatial-hotspot.js");
		int toolsScript = body.indexOf("/js/map-tools.js");
		int mapScript = body.indexOf("/js/vworld-map.js");
		assertThat(hotspotScript).isPositive();
		assertThat(body.indexOf("/js/spatial-hotspot.js", hotspotScript + 1)).as("loaded once").isEqualTo(-1);
		// spatial-hotspot.js uses window.gisSpatialApi, gisSpatialViews, gisSpatialDashboard, gisAnalysis(Renderer) and
		// gisGridModel.attachRenderer, and listens to gis:spatiallayerchange from spatial-grid.js: it comes after all of
		// them. Its renderer connects on gis:mapready, so it comes before vworld-map.js (map initialization stays last).
		assertThat(hotspotScript).isGreaterThan(vworldLoader).isGreaterThan(analysisScript).isGreaterThan(historyScript)
			.isGreaterThan(apiScript).isGreaterThan(viewsScript).isGreaterThan(dashboardScript)
			.isGreaterThan(rendererScript).isGreaterThan(gridScript);
		assertThat(toolsScript).isGreaterThan(hotspotScript);
		assertThat(mapScript).isGreaterThan(hotspotScript).isGreaterThan(toolsScript);
		assertThat(body.substring(hotspotScript, hotspotScript + 120)).contains("data-api-base=\"/api\"");
	}

}
