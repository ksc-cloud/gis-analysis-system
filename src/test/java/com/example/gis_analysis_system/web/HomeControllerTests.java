package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Starts the embedded Tomcat so that JSP and JSTL are actually rendered by Jasper.
 */
// The key is cleared explicitly so a local VWORLD_API_KEY or application-local.properties cannot affect the result.
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT, properties = "vworld.api-key=")
class HomeControllerTests {

	private final HttpClient httpClient = HttpClient.newHttpClient();

	@LocalServerPort
	private int port;

	@Test
	void homeRendersJspWithJstl() throws Exception {
		HttpResponse<String> response = get("/");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
				(contentType) -> assertThat(contentType).startsWith("text/html"));
		assertThat(response.body())
			.contains("<h1 class=\"app-header__title\">GIS 3D 지도</h1>")
			.contains("class=\"app-header__logo\"")
			.contains("<title>GIS 3D 지도 | gis-analysis-system</title>")
			// The header shows only the logo and the title (no subtitle or status text).
			.doesNotContain("app-header__subtitle")
			.doesNotContain("status-badge")
			.doesNotContain("JSP 화면이 정상적으로 실행되었습니다.")
			.doesNotContain("<c:");
	}

	@Test
	void homeRendersDashboardLayout() throws Exception {
		String body = get("/").body();

		assertThat(body)
			.contains("id=\"app-header\"")
			.contains("id=\"sidebar\"")
			.contains("id=\"map\"")
			.contains("id=\"info-panel\"")
			.contains("id=\"sidebar-toggle\"")
			.contains("id=\"info-panel-toggle\"")
			.contains("선택된 건물이 없습니다.")
			.contains("id=\"building-clear\"")
			.contains("id=\"selection-bar\"")
			.contains("href=\"/css/main.css\"")
			.contains("src=\"/js/main.js\"");
	}

	@Test
	void stylesheetIsServed() throws Exception {
		HttpResponse<String> response = get("/css/main.css");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
				(contentType) -> assertThat(contentType).startsWith("text/css"));
		assertThat(response.body()).contains("#map");
	}

	@Test
	void scriptIsServed() throws Exception {
		HttpResponse<String> response = get("/js/main.js");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
				(contentType) -> assertThat(contentType).contains("javascript"));
		assertThat(response.body()).contains("sidebar-toggle");
	}

	@Test
	void homeShowsGuideAndSkipsVWorldScriptsWithoutApiKey() throws Exception {
		String body = get("/").body();

		assertThat(body)
			.contains("id=\"map\"")
			.contains("data-state=\"no-key\"")
			.contains("VWorld API 키가 설정되지 않았습니다.")
			.contains("VWORLD_API_KEY")
			.doesNotContain("map.vworld.kr")
			.doesNotContain("jquery")
			.doesNotContain("vworld-map.js")
			.doesNotContain("building-info.js")
			.doesNotContain("map-tools.js")
			.doesNotContain("map-layers.js")
			// Without a key the map never becomes ready, so the tools stay disabled.
			.contains("data-mode=\"distance\" aria-pressed=\"false\" disabled")
			.contains("data-layer=\"facility_build\" checked disabled");
	}

	@Test
	void vworldMapScriptIsServed() throws Exception {
		HttpResponse<String> response = get("/js/vworld-map.js");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
				(contentType) -> assertThat(contentType).contains("javascript"));
		assertThat(response.body()).contains("ws3dInitCallBack");
	}

	@Test
	void mapToolScriptsAreServed() throws Exception {
		for (String path : new String[] { "/js/map-tools.js", "/js/map-layers.js", "/js/map-analysis.js",
				"/js/map-analysis-renderer.js" }) {
			HttpResponse<String> response = get(path);
			assertThat(response.statusCode()).isEqualTo(200);
			assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
					(contentType) -> assertThat(contentType).contains("javascript"));
		}
		assertThat(get("/js/map-tools.js").body()).contains("vw.MeasureLine").contains("gis:modechange");
		assertThat(get("/js/map-layers.js").body()).contains("facility_build").contains("gis:layerchange");
		assertThat(get("/js/map-analysis.js").body()).contains("gis:measurereset").contains("AbortController");
		assertThat(get("/js/map-analysis-renderer.js").body()).contains("vw.geom.CircleZ").contains("removeObject");
	}

	@Test
	void historyScriptIsServedButNotLoadedWithoutApiKey() throws Exception {
		HttpResponse<String> response = get("/js/map-history.js");

		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
				(contentType) -> assertThat(contentType).contains("javascript"));
		assertThat(response.body()).contains("gis:analysisresult").contains("/api/analyses").contains("textContent");
		assertThat(get("/").body()).doesNotContain("map-history.js").contains("id=\"tab-history\"");
	}

	@Test
	void searchScriptIsServedAndTheMapHidesTheVWorldMeasureButtons() throws Exception {
		HttpResponse<String> search = get("/js/map-search.js");

		assertThat(search.statusCode()).isEqualTo(200);
		assertThat(search.body()).contains("/api/search").contains("gis:measurereset").contains("startAt");
		assertThat(get("/js/vworld-map.js").body()).contains("isZoomControl: true").contains("navigation: true");
		assertThat(get("/js/main.js").body()).contains("keepKeysInFields");
		// Without a key the map scripts are not loaded, so the search form stays disabled.
		assertThat(get("/").body()).doesNotContain("map-search.js")
			.contains("id=\"map-search-input\" class=\"search-form__input\"");
	}

	@Test
	void spatialScriptsAreServedButNotLoadedWithoutApiKey() throws Exception {
		HttpResponse<String> api = get("/js/spatial-api.js");
		HttpResponse<String> views = get("/js/spatial-views.js");
		HttpResponse<String> dashboard = get("/js/spatial-dashboard.js");
		HttpResponse<String> compare = get("/js/spatial-compare.js");
		HttpResponse<String> gridRenderer = get("/js/spatial-grid-renderer.js");
		HttpResponse<String> grid = get("/js/spatial-grid.js");

		for (HttpResponse<String> response : List.of(api, views, dashboard, compare, gridRenderer, grid)) {
			assertThat(response.statusCode()).isEqualTo(200);
			assertThat(response.headers().firstValue("Content-Type")).hasValueSatisfying(
					(contentType) -> assertThat(contentType).contains("javascript"));
			// Only the Java API is called; the Python address and the internal token never reach the browser.
			assertThat(response.body()).doesNotContain("8001").doesNotContain("X-Internal-Token")
				.doesNotContain("/internal/").doesNotContain("innerHTML");
		}
		assertThat(api.body()).contains("/spatial-analysis/status").contains("/analysis-snapshots/")
			.contains("/statistics").contains("Intl.NumberFormat('ko-KR'");
		assertThat(dashboard.body()).contains("gis:analysisresult").contains("gis:analysissaved")
			.contains("gis:tabchange").contains("AbortController").contains("textContent");
		// Switching the views (and its gis:spatialviewchange event) is spatial-views.js; the compare view asks it.
		assertThat(views.body()).contains("gis:spatialviewchange").contains("gisSpatialViews").contains("aria-pressed")
			.doesNotContain("innerHTML");
		assertThat(compare.body()).contains("/comparison?with=").doesNotContain("신축했").contains("gis:compareselection")
			.contains("gis:historychange").contains("gisSpatialViews").contains("AbortController");
		assertThat(api.body()).contains("/comparison?with=").contains("%p").contains("/grid-density");
		// The grid uses the public VWorld shape API (map.clear() is checked on the code without comments in the JS tests).
		assertThat(gridRenderer.body()).contains("vw.geom.PolygonZ").contains("removeObject")
			.doesNotContain("ws3d");
		assertThat(grid.body()).contains("gis:measurereset").contains("gis:analysissaved").contains("suppressNextMapClick")
			.contains("setBuildingsVisible").contains("AbortController");
		assertThat(get("/js/map-analysis-renderer.js").body()).contains("setBuildingsVisible");
		assertThat(get("/js/map-analysis.js").body()).contains("suppressNextMapClick");
		assertThat(get("/js/map-history.js").body()).contains("gis:analysissaved").contains("gis:historychange")
			.contains("gis:compareselection");
		// Without a key the map scripts are not loaded, but the tab markup is still rendered.
		assertThat(get("/").body()).doesNotContain("spatial-views.js").doesNotContain("spatial-dashboard.js")
			.doesNotContain("spatial-compare.js")
			.doesNotContain("spatial-grid.js").doesNotContain("spatial-grid-renderer.js")
			.contains("id=\"tab-spatial\"")
			.contains("id=\"spatial-section\"");
	}

	@Test
	void jspIsNotDirectlyAccessible() throws Exception {
		assertThat(get("/WEB-INF/views/index.jsp").statusCode()).isEqualTo(404);
	}

	private HttpResponse<String> get(String path) throws IOException, InterruptedException {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + path)).build();
		return this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

}
