package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
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
			.contains("gis-analysis-system")
			.contains("JSP 화면이 정상적으로 실행되었습니다.")
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
			.doesNotContain("building-info.js");
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
	void jspIsNotDirectlyAccessible() throws Exception {
		assertThat(get("/WEB-INF/views/index.jsp").statusCode()).isEqualTo(404);
	}

	private HttpResponse<String> get(String path) throws IOException, InterruptedException {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + path)).build();
		return this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

}
