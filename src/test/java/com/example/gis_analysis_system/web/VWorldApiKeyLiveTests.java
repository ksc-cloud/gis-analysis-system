package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import com.example.gis_analysis_system.vworld.BuildingLookupResult;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;

import tools.jackson.databind.json.JsonMapper;

/**
 * Calls the real VWorld server. Runs only when the VWORLD_API_KEY environment variable is set,
 * so the regular build never needs a key or network access to VWorld.
 * Optional VWORLD_SERVICE_URL (default http://localhost:8080/) is sent as the Referer, and optional
 * VWORLD_DOMAIN (default http://localhost:8080) is sent as the data API domain parameter.
 */
@Tag("vworld-live")
@EnabledIfEnvironmentVariable(named = "VWORLD_API_KEY", matches = ".*[^ ].*")
class VWorldApiKeyLiveTests {

	private static final String LOADER_URL = "https://map.vworld.kr/js/webglMapInit.js.do?version=3.0&apiKey=";

	private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

	@Test
	void configuredApiKeyIsAcceptedByVWorld() throws Exception {
		String body = loadLoader(System.getenv("VWORLD_API_KEY").trim());

		assertThat(body).contains("var vworldApiKey").doesNotContain("vworldIsValid = 'false'");
	}

	@Test
	void invalidApiKeyIsReportedByVWorld() throws Exception {
		String body = loadLoader("INVALID-KEY-FOR-TEST");

		assertThat(body).contains("vworldIsValid = 'false'").contains("vworldErrMsg");
	}

	/**
	 * Confirms that the real LT_C_SPBD response has the structure VWorldBuildingClient expects.
	 * An UNEXPECTED_RESPONSE or API_ERROR (for example when the key has no data API access) fails this test.
	 */
	@Test
	void buildingDataApiResponseCanBeParsed() {
		VWorldBuildingClient client = new VWorldBuildingClient(JsonMapper.builder().build(),
				System.getenv("VWORLD_API_KEY"), System.getenv().getOrDefault("VWORLD_DOMAIN", "http://localhost:8080"));

		// Seoul City Hall (서울특별시청), Sejong-daero 110
		BuildingLookupResult result = client.findBuildingsAt(126.97797, 37.56650);

		assertThat(result.status()).isNotNull();
		System.out.println("[vworld-live] LT_C_SPBD at Seoul City Hall: " + result);
	}

	/**
	 * Confirms that the real POINT + buffer response (geometry=true) can be parsed into footprints.
	 */
	@Test
	void radiusQueryResponseCanBeParsed() {
		VWorldBuildingClient client = new VWorldBuildingClient(JsonMapper.builder().build(),
				System.getenv("VWORLD_API_KEY"), System.getenv().getOrDefault("VWORLD_DOMAIN", "http://localhost:8080"));

		VWorldBuildingClient.FeaturePage page = client.findBuildingsWithin(126.97797, 37.56650, 100, 1);

		assertThat(page.reportedTotal()).isPositive();
		assertThat(page.currentPage()).isEqualTo(1);
		assertThat(page.features()).isNotEmpty().allSatisfy((feature) -> assertThat(feature.hasGeometry()).isTrue());
		System.out.println("[vworld-live] LT_C_SPBD within 100 m: total " + page.reportedTotal() + ", pages "
				+ page.totalPages());
	}

	private String loadLoader(String apiKey) throws Exception {
		String serviceUrl = System.getenv().getOrDefault("VWORLD_SERVICE_URL", "http://localhost:8080/");
		HttpRequest request = HttpRequest
			.newBuilder(URI.create(LOADER_URL + URLEncoder.encode(apiKey, StandardCharsets.UTF_8)))
			.header("Referer", serviceUrl)
			.timeout(Duration.ofSeconds(20))
			.build();
		HttpResponse<String> response = this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
		assertThat(response.statusCode()).isEqualTo(200);
		return response.body();
	}

}
