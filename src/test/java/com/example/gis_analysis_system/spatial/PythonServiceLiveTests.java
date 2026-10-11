package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

import java.time.Instant;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.spatial.AnalysisServiceClient.Endpoint;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;
import com.example.gis_analysis_system.spatial.PythonRequestMapper.AnalysisSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Opt-in: the real client and mapper against a running Python analysis service. Runs only when ANALYSIS_IT_URL
 * (loopback, for example http://127.0.0.1:8001) and ANALYSIS_IT_TOKEN (that server's ANALYSIS_INTERNAL_TOKEN) are
 * set. Only sends analysis requests; never stops or changes the server.
 */
@Tag("python")
@EnabledIfEnvironmentVariable(named = "ANALYSIS_IT_URL", matches = ".+")
class PythonServiceLiveTests {

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	private final PythonRequestMapper mapper = new PythonRequestMapper(this.jsonMapper);

	private AnalysisServiceClient client;

	@BeforeEach
	void setUp() {
		this.client = new AnalysisServiceClient(
				AnalysisServiceProperties.of(System.getenv("ANALYSIS_IT_URL"), System.getenv("ANALYSIS_IT_TOKEN")),
				this.jsonMapper);
	}

	@Test
	void statusIsAvailable() {
		assertThat(this.client.isConfigured()).isTrue();
		assertThat(this.client.isAvailable()).isTrue();
	}

	@Test
	void buildingStatsOfALiveResult() {
		RadiusAnalysisResult result = SpatialFixtures.liveResult();
		JsonNode response = this.client.post(Endpoint.BUILDING_STATS,
				this.mapper.buildingStats(result, new AnalysisSource(null, Instant.now()), true));

		assertThat(response.get("counts").get("total").asInt()).isEqualTo(result.buildings().size());
		assertThat(response.get("counts").get("relationMismatch").asInt()).isZero();
		assertThat(response.get("counts").get("distanceMismatch").asInt()).isZero();
		assertThat(response.get("completeness").get("scope").asString()).isEqualTo("OBSERVED_BUILDINGS_ONLY");
		assertThat(response.get("source").get("kind").asString()).isEqualTo("LIVE");
	}

	@Test
	void gridDensityOf5000Buildings() {
		RadiusAnalysisResult result = SpatialFixtures.syntheticResult(5000, 0);
		for (int cellSize : new int[] { 50, 100, 200 }) {
			JsonNode response = this.client.post(Endpoint.GRID_DENSITY, this.mapper.gridDensity(result,
					new AnalysisSource(1L, Instant.parse("2026-10-11T03:00:00Z")), cellSize, true, false));

			assertThat(response.get("cellSizeMeters").asInt()).isEqualTo(cellSize);
			assertThat(response.get("counts").get("analyzed").asInt()).isEqualTo(5000);
			assertThat(response.get("consistency").get("occupiedAreaMatches").asBoolean()).isTrue();
		}
	}

	@Test
	void compareTwo5000BuildingAnalyses() {
		byte[] body = this.mapper.compare(SpatialFixtures.syntheticResult(5000, 0),
				new AnalysisSource(1L, Instant.parse("2026-03-01T00:00:00Z")), SpatialFixtures.syntheticResult(5000, 1),
				new AnalysisSource(2L, Instant.parse("2026-09-01T00:00:00Z")), false, true);
		JsonNode response = this.client.post(Endpoint.COMPARE, body);

		assertThat(response.get("comparable").asBoolean()).isTrue();
		assertThat(response.get("comparisonBasis").asString()).isEqualTo("CHANGE");
		JsonNode summary = response.get("buildings").get("summary");
		assertThat(summary.get("matched").asInt()).isEqualTo(5000);
		assertThat(summary.get("modified").asInt()).isEqualTo(500);  // floors of every 10th building changed
		assertThat(summary.get("added").asInt()).isZero();
	}

	@Test
	void wrongTokenIsAuthFailed() {
		AnalysisServiceClient wrong = new AnalysisServiceClient(
				AnalysisServiceProperties.of(System.getenv("ANALYSIS_IT_URL"), "wrong-token"), this.jsonMapper);

		assertThatExceptionOfType(AnalysisServiceException.class)
			.isThrownBy(() -> wrong.post(Endpoint.BUILDING_STATS, this.mapper
				.buildingStats(SpatialFixtures.syntheticResult(1, 0), new AnalysisSource(null, Instant.now()), false)))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(Reason.ANALYSIS_SERVICE_AUTH_FAILED));
	}

}
