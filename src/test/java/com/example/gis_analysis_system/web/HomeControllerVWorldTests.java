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
		int mapScript = body.indexOf("/js/vworld-map.js");
		assertThat(jquery).isPositive();
		assertThat(loader).isGreaterThan(jquery);
		// building-info.js must be loaded before vworld-map.js so it does not miss the gis:mapready event.
		assertThat(buildingScript).isGreaterThan(loader);
		assertThat(mapScript).isGreaterThan(buildingScript);
		assertThat(body).contains("data-api-url=\"/api/buildings/at\"");
	}

}
