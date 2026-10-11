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
			.contains("<button type=\"button\" class=\"spatial-views__button\" aria-pressed=\"true\">통계</button>")
			.contains("data-api-base=\"/api\"");
		// Grid and comparison are announced but cannot be used yet (steps 8-6B and 8-6C).
		assertThat(body.split("class=\"spatial-views__button\" aria-pressed=\"false\" disabled", -1)).hasSize(3);
		assertThat(body).contains(">격자 <span class=\"spatial-views__soon\">준비 중</span>")
			.contains(">비교 <span class=\"spatial-views__soon\">준비 중</span>");

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

}
