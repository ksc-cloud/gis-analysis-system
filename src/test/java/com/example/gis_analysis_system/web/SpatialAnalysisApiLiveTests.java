package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.BDDMockito.given;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Opt-in: the Java HTTP API end to end with a running Python service (ANALYSIS_IT_URL / ANALYSIS_IT_TOKEN), without
 * a database: radius analysis (VWorld mocked) -> snapshot statistics and grid density -> status.
 */
@Tag("python")
@EnabledIfEnvironmentVariable(named = "ANALYSIS_IT_URL", matches = ".+")
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT,
		properties = { "vworld.api-key=", "analysis-service.base-url=${ANALYSIS_IT_URL}",
				"analysis-service.internal-token=${ANALYSIS_IT_TOKEN:}" })
class SpatialAnalysisApiLiveTests {

	private static final BuildingInfo CITY_HALL = new BuildingInfo("1114010300100310000000001", "서울특별시청", null,
			"13", "서울특별시", "중구", null, "세종대로", "110");

	private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	@LocalServerPort
	private int port;

	@MockitoBean
	private VWorldBuildingClient buildingClient;

	@Test
	void snapshotAnalysesThroughTheJavaApi() throws Exception {
		double d = 0.0001;
		double[][][] polygon = { { { 126.978 - d, 37.5665 - d }, { 126.978 + d, 37.5665 - d },
				{ 126.978 + d, 37.5665 + d }, { 126.978 - d, 37.5665 + d }, { 126.978 - d, 37.5665 - d } } };
		given(this.buildingClient.findBuildingsWithin(anyDouble(), anyDouble(), anyInt(), anyInt()))
			.willReturn(new FeaturePage(1, 1, 1,
					List.of(new BuildingFeature("LT_C_SPBD.1", CITY_HALL, List.<double[][][]>of(polygon)))));
		String token = json(send("/api/buildings/nearby?lon=126.978&lat=37.5665&radius=100")).get("analysisToken")
			.asString();

		HttpResponse<String> statistics = send("/api/analysis-snapshots/" + token + "/statistics");
		assertThat(statistics.statusCode()).isEqualTo(200);
		JsonNode stats = json(statistics);
		assertThat(stats.get("analysisIds")).isEmpty();
		assertThat(stats.get("analysisService").get("schemaVersion").asInt()).isEqualTo(1);
		assertThat(stats.get("result").get("counts").get("analyzed").asInt()).isEqualTo(1);
		assertThat(stats.get("result").get("footprint").get("sumArea").asDouble()).isGreaterThan(300);

		HttpResponse<String> grid = send("/api/analysis-snapshots/" + token + "/grid-density?cellSize=50");
		assertThat(grid.statusCode()).isEqualTo(200);
		assertThat(json(grid).get("result").get("cells").get("type").asString()).isEqualTo("FeatureCollection");

		assertThat(send("/api/spatial-analysis/status").body()).isEqualTo("{\"available\":true,\"configured\":true}");
	}

	private HttpResponse<String> send(String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + path))
			.timeout(Duration.ofSeconds(30))
			.GET()
			.build();
		return this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

	private JsonNode json(HttpResponse<String> response) {
		return this.jsonMapper.readTree(response.body());
	}

}
