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

}
