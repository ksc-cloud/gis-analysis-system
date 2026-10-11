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
import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.spatial.AnalysisServiceProperties;
import com.example.gis_analysis_system.spatial.PythonRequestMapper;
import com.example.gis_analysis_system.spatial.PythonRequestMapper.AnalysisSource;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.BuildingLookupResult;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The whole application with the Python service configured but not running (closed port 9) and no database: the
 * map, the building lookup and the radius analysis keep working; only the spatial analysis endpoints answer 503, and
 * neither the token nor the snapshot token reaches a response or the log. VWorld is mocked.
 */
@ExtendWith(OutputCaptureExtension.class)
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT,
		properties = { "vworld.api-key=", "analysis-service.base-url=http://127.0.0.1:9",
				"analysis-service.internal-token=" + PythonDownTests.TOKEN,
				"spring.datasource.url=jdbc:mariadb://127.0.0.1:9/gis_analysis_test?connectTimeout=1000",
				"spring.datasource.username=gis_test", "spring.datasource.password=" })
class PythonDownTests {

	static final String TOKEN = "python-down-test-token-91c2";

	private static final BuildingInfo CITY_HALL = new BuildingInfo("1114010300100310000000001", "서울특별시청", null,
			"13", "서울특별시", "중구", null, "세종대로", "110");

	private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	@LocalServerPort
	private int port;

	@MockitoBean
	private VWorldBuildingClient buildingClient;

	@Autowired
	private AnalysisServiceProperties properties;

	@Autowired
	private PythonRequestMapper requestMapper;

	@BeforeEach
	void mockVWorld() {
		given(this.buildingClient.findBuildingsAt(anyDouble(), anyDouble()))
			.willReturn(new BuildingLookupResult(BuildingLookupResult.Status.FOUND, 1, List.of(CITY_HALL)));
		double d = 0.0001;
		double[][][] polygon = { { { 126.978 - d, 37.5665 - d }, { 126.978 + d, 37.5665 - d },
				{ 126.978 + d, 37.5665 + d }, { 126.978 - d, 37.5665 - d } } };
		given(this.buildingClient.findBuildingsWithin(anyDouble(), anyDouble(), anyInt(), anyInt()))
			.willReturn(new FeaturePage(1, 1, 1,
					List.of(new BuildingFeature("LT_C_SPBD.1", CITY_HALL, List.<double[][][]>of(polygon)))));
	}

	@Test
	void existingFeaturesWorkAndOnlySpatialAnalysisFails(CapturedOutput output) throws Exception {
		assertThat(send("/").statusCode()).isEqualTo(200);
		assertThat(send("/api/buildings/at?lon=126.978&lat=37.5665").statusCode()).isEqualTo(200);
		HttpResponse<String> nearby = send("/api/buildings/nearby?lon=126.978&lat=37.5665&radius=100");
		assertThat(nearby.statusCode()).isEqualTo(200);
		String snapshotToken = json(nearby).get("analysisToken").asString();

		HttpResponse<String> status = send("/api/spatial-analysis/status");
		assertThat(status.statusCode()).isEqualTo(200);
		assertThat(status.body()).isEqualTo("{\"available\":false,\"configured\":true}");

		HttpResponse<String> snapshot = send("/api/analysis-snapshots/" + snapshotToken + "/statistics");
		assertThat(snapshot.statusCode()).isEqualTo(503);
		assertThat(json(snapshot).get("error").asString()).isEqualTo("ANALYSIS_SERVICE_UNAVAILABLE");

		// Within the cooldown the saved analysis endpoints answer at once, without touching the (absent) database.
		long started = System.nanoTime();
		HttpResponse<String> saved = send("/api/analyses/1/grid-density?cellSize=50");
		assertThat(saved.statusCode()).isEqualTo(503);
		assertThat(json(saved).get("error").asString()).isEqualTo("ANALYSIS_SERVICE_UNAVAILABLE");
		assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1));

		// The radius analysis still works afterwards.
		assertThat(send("/api/buildings/nearby?lon=126.978&lat=37.5665&radius=100").statusCode()).isEqualTo(200);

		for (HttpResponse<String> response : List.of(status, snapshot, saved)) {
			assertThat(response.body()).doesNotContain(TOKEN).doesNotContain(snapshotToken).doesNotContain("127.0.0.1");
		}
		assertThat(output.getAll()).doesNotContain(TOKEN).doesNotContain(snapshotToken);
	}

	@Test
	void settingsAreBoundFromProperties() {
		assertThat(this.properties.isConfigured()).isTrue();
		assertThat(this.properties.internalToken()).isEqualTo(TOKEN);
		assertThat(this.properties.readTimeout()).isEqualTo(Duration.ofSeconds(15));
		assertThat(this.properties.compareReadTimeout()).isEqualTo(Duration.ofSeconds(30));
		assertThat(this.properties.compareMaxRequestBytes().toBytes()).isEqualTo(32L * 1024 * 1024);
		assertThat(this.properties.toString()).doesNotContain(TOKEN);
	}

	@Test
	void springJsonMapperWritesTheSameRequestAsAPlainMapper() {
		RadiusAnalysisResult result = new com.example.gis_analysis_system.analysis.RadiusAnalysisService(
				this.buildingClient)
			.analyze(126.978, 37.5665, 100);
		AnalysisSource source = new AnalysisSource(7L, Instant.parse("2026-10-11T03:00:00.120Z"));

		byte[] spring = this.requestMapper.buildingStats(result, source, false);
		byte[] plain = new PythonRequestMapper(this.jsonMapper).buildingStats(result, source, false);

		assertThat(new String(spring, StandardCharsets.UTF_8)).isEqualTo(new String(plain, StandardCharsets.UTF_8))
			.contains("\"analyzedAt\":\"2026-10-11T03:00:00.120Z\"");
	}

	private HttpResponse<String> send(String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + this.port + path))
			.timeout(Duration.ofSeconds(20))
			.GET()
			.build();
		return this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

	private JsonNode json(HttpResponse<String> response) {
		return this.jsonMapper.readTree(response.body());
	}

}
