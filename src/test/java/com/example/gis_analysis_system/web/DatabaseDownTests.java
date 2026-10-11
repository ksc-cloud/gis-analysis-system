package com.example.gis_analysis_system.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.BDDMockito.given;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.example.gis_analysis_system.history.AnalysisSnapshotStore;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.BuildingLookupResult;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The whole application with an unreachable database (closed port): stage 1~6 pages and APIs keep working, the
 * radius analysis still issues save tokens, and only /api/analyses answers 503. VWorld is mocked; everything else
 * (Tomcat, JSP, MyBatis, HikariCP, the MariaDB driver) is real.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT,
		properties = { "vworld.api-key=", "spring.datasource.url=jdbc:mariadb://127.0.0.1:9/gis_analysis_test?connectTimeout=1000",
				"spring.datasource.username=gis_test", "spring.datasource.password=" })
class DatabaseDownTests {

	private static final BuildingInfo CITY_HALL = new BuildingInfo("1114010300100310000000001", "서울특별시청", null,
			"13", "서울특별시", "중구", null, "세종대로", "110");

	private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	@LocalServerPort
	private int port;

	@MockitoBean
	private VWorldBuildingClient buildingClient;

	@Autowired
	private AnalysisSnapshotStore snapshotStore;

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
	void mapPagesAndStaticFilesWork() throws Exception {
		HttpResponse<String> home = send(get("/"));
		assertThat(home.statusCode()).isEqualTo(200);
		assertThat(home.body()).contains("id=\"map\"").contains("id=\"analysis-section\"");
		for (String path : new String[] { "/css/main.css", "/js/main.js", "/js/vworld-map.js", "/js/building-info.js",
				"/js/map-tools.js", "/js/map-layers.js", "/js/map-analysis.js", "/js/map-analysis-renderer.js" }) {
			assertThat(send(get(path)).statusCode()).as(path).isEqualTo(200);
		}
	}

	@Test
	void buildingLookupAndRadiusAnalysisWorkWhileHistoryIs503() throws Exception {
		HttpResponse<String> at = send(get("/api/buildings/at?lon=126.978&lat=37.5665"));
		assertThat(at.statusCode()).isEqualTo(200);
		assertThat(json(at).path("buildings").get(0).path("buildingName").asString()).isEqualTo("서울특별시청");

		HttpResponse<String> nearby = send(get("/api/buildings/nearby?lon=126.978&lat=37.5665&radius=100"));
		assertThat(nearby.statusCode()).isEqualTo(200);
		JsonNode analysis = json(nearby);
		assertThat(analysis.path("summary").path("intersecting").asInt()).isEqualTo(1);
		String token = analysis.path("analysisToken").asString();

		long started = System.nanoTime();
		HttpResponse<String> save = send(postJson("/api/analyses",
				"{\"analysisToken\":\"" + token + "\",\"title\":\"DB 중단 중 저장\"}"));
		long elapsedMillis = (System.nanoTime() - started) / 1_000_000;
		assertThat(save.statusCode()).isEqualTo(503);
		assertThat(json(save).path("error").asString()).isEqualTo("DB_UNAVAILABLE");
		assertThat(elapsedMillis).as("bounded by the 3 s pool timeout").isLessThan(10_000);
		assertThat(this.snapshotStore.find(UUID.fromString(token))).as("token kept for a later retry").isPresent();

		for (HttpRequest request : new HttpRequest[] { get("/api/analyses"), get("/api/analyses/1"),
				HttpRequest.newBuilder(uri("/api/analyses/1")).DELETE().build() }) {
			HttpResponse<String> response = send(request);
			assertThat(response.statusCode()).as(request.method() + " " + request.uri()).isEqualTo(503);
			assertThat(json(response).path("error").asString()).isEqualTo("DB_UNAVAILABLE");
			assertThat(response.body()).doesNotContain("jdbc:").doesNotContain("SQL");
		}

		// The map features are unaffected by the failed database calls.
		assertThat(send(get("/api/buildings/nearby?lon=126.978&lat=37.5665&radius=500")).statusCode()).isEqualTo(200);
		assertThat(send(get("/api/buildings/at?lon=126.978&lat=37.5665")).statusCode()).isEqualTo(200);
		assertThat(send(get("/")).statusCode()).isEqualTo(200);
	}

	@Test
	void validationErrorsDoNotNeedTheDatabase() throws Exception {
		HttpResponse<String> badToken = send(postJson("/api/analyses", "{\"analysisToken\":\"x\",\"title\":\"t\"}"));
		assertThat(badToken.statusCode()).isEqualTo(400);
		assertThat(json(badToken).path("error").asString()).isEqualTo("INVALID_TOKEN");
		assertThat(send(get("/api/analyses?sort=title")).statusCode()).isEqualTo(400);
		assertThat(send(get("/api/analyses/abc")).statusCode()).isEqualTo(400);
	}

	/** A chunked body (no Content-Length) is cut off once it passes the limit, on the real Tomcat. */
	@Test
	void chunkedOversizedBodyIs413() throws Exception {
		byte[] body = ("{\"analysisToken\":\"" + UUID.randomUUID() + "\",\"title\":\"" + "가".repeat(20_000) + "\"}")
			.getBytes(StandardCharsets.UTF_8);
		HttpRequest request = HttpRequest.newBuilder(uri("/api/analyses"))
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(body)))
			.build();

		HttpResponse<String> response = send(request);

		assertThat(response.statusCode()).isEqualTo(413);
		assertThat(json(response).path("error").asString()).isEqualTo("PAYLOAD_TOO_LARGE");
	}

	private JsonNode json(HttpResponse<String> response) {
		return this.jsonMapper.readTree(response.body());
	}

	private HttpRequest get(String path) {
		return HttpRequest.newBuilder(uri(path)).GET().build();
	}

	private HttpRequest postJson(String path, String json) {
		return HttpRequest.newBuilder(uri(path))
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
			.build();
	}

	private URI uri(String path) {
		return URI.create("http://localhost:" + this.port + path);
	}

	private HttpResponse<String> send(HttpRequest request) throws Exception {
		return this.httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
	}

}
