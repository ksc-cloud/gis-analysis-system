package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import com.example.gis_analysis_system.history.AnalysisHistoryService;
import com.example.gis_analysis_system.history.AnalysisSnapshot;
import com.example.gis_analysis_system.history.AnalysisSnapshotStore;
import com.example.gis_analysis_system.spatial.SpatialAnalysisService.SpatialAnalysisResponse;

/**
 * Opt-in: two analyses saved in gis_analysis_test, read back and compared by a running Python service, through the
 * real service layer. Needs GIS_TEST_DB_URL / GIS_TEST_DB_USERNAME / GIS_TEST_DB_PASSWORD (gis_analysis_test only)
 * and ANALYSIS_IT_URL / ANALYSIS_IT_TOKEN. Deletes exactly the analyses it saved.
 */
@Tag("mariadb")
@Tag("python")
@EnabledIfEnvironmentVariable(named = "GIS_TEST_DB_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "ANALYSIS_IT_URL", matches = ".+")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE,
		properties = { "vworld.api-key=", "analysis-service.base-url=${ANALYSIS_IT_URL}",
				"analysis-service.internal-token=${ANALYSIS_IT_TOKEN:}" })
class SpatialAnalysisMariaDbLiveTests {

	@Autowired
	private SpatialAnalysisService service;

	@Autowired
	private AnalysisHistoryService historyService;

	@Autowired
	private AnalysisSnapshotStore snapshotStore;

	private final List<Long> created = new ArrayList<>();

	@BeforeAll
	static void requireTestDatabase() {
		// Same guard as history.MariaDbTestDatabase: never the development database or account.
		String url = System.getenv("GIS_TEST_DB_URL");
		assertThat(url).startsWith("jdbc:mariadb://");
		assertThat(URI.create(url.substring("jdbc:".length())).getPath()).isEqualTo("/gis_analysis_test");
		assertThat(System.getenv("GIS_TEST_DB_USERNAME")).isNotBlank().isNotEqualTo("gis_app");
	}

	@AfterEach
	void deleteOwnAnalyses() {
		for (Long id : this.created) {
			this.historyService.delete(id);
		}
	}

	@Test
	void savedAnalysesAreAnalysedAndCompared() {
		long first = save(SpatialFixtures.syntheticResult(300, 0), "8-5 비교 테스트 이전");
		long second = save(SpatialFixtures.syntheticResult(300, 1), "8-5 비교 테스트 이후");

		SpatialAnalysisResponse statistics = this.service.savedStatistics(first, false);
		assertThat(statistics.analysisIds()).containsExactly(first);
		assertThat(statistics.result().get("source").get("kind").asString()).isEqualTo("SAVED");
		assertThat(statistics.result().get("counts").get("analyzed").asInt()).isEqualTo(300);

		SpatialAnalysisResponse grid = this.service.savedGridDensity(second, 100, false, true);
		assertThat(grid.result().get("consistency").get("primaryMatchesAnalyzed").asBoolean()).isTrue();

		// Ids in reverse order: the older analysis is still "before".
		SpatialAnalysisResponse comparison = this.service.comparison(second, first, false, true);
		assertThat(comparison.analysisIds()).containsExactly(first, second);
		assertThat(comparison.result().get("comparable").asBoolean()).isTrue();
		assertThat(comparison.result().get("buildings").get("summary").get("modified").asInt()).isEqualTo(30);
	}

	@Test
	void snapshotBeforeSaving() {
		AnalysisSnapshot snapshot = this.snapshotStore.put(SpatialFixtures.liveResult());

		SpatialAnalysisResponse response = this.service.snapshotGridDensity(snapshot.token().toString(), 50, true,
				false);

		assertThat(response.analysisIds()).isEmpty();
		assertThat(response.result().get("completeness").get("complete").asBoolean()).isFalse();
		// Still savable afterwards.
		this.created.add(this.historyService.save(snapshot.token().toString(), "8-5 스냅샷 테스트").analysisId());
	}

	private long save(com.example.gis_analysis_system.analysis.RadiusAnalysisResult result, String title) {
		AnalysisSnapshot snapshot = this.snapshotStore.put(result);
		long id = this.historyService.save(snapshot.token().toString(), title).analysisId();
		this.created.add(id);
		return id;
	}

}
