package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.IntFunction;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.history.AnalysisHistoryService.SavedAnalysis;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The service with real transactions on gis_analysis_test: commits, full rollback, duplicate protection under
 * concurrency and the restored result. Each test deletes exactly the analyses it created.
 */
@Tag("mariadb")
@EnabledIfEnvironmentVariable(named = MariaDbTestDatabase.ENABLED_VARIABLE, matches = ".+")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "vworld.api-key=")
class AnalysisHistoryServiceMariaDbTests {

	@Autowired
	private AnalysisHistoryService service;

	@Autowired
	private AnalysisSnapshotStore store;

	@Autowired
	private AnalysisHistoryMapper mapper;

	@Autowired
	private PlatformTransactionManager transactionManager;

	@Autowired
	private JsonMapper jsonMapper;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	private final List<Long> created = new CopyOnWriteArrayList<>();

	private final List<String> tokens = new CopyOnWriteArrayList<>();

	@BeforeAll
	static void requireTestDatabase() {
		MariaDbTestDatabase.requireTestDatabase();
	}

	@AfterEach
	void deleteOwnRows() {
		for (Long id : this.created) {
			this.mapper.deleteHistory(id);
		}
		for (String token : this.tokens) {
			Long id = this.mapper.findIdByToken(token);
			if (id != null) {
				this.mapper.deleteHistory(id);
			}
		}
	}

	@Test
	void savedAnalysisIsRestoredExactlyIncludingSqlFloorStatistics() {
		RadiusAnalysisResult live = AnalysisFixtures.liveResult();
		AnalysisSnapshot snapshot = put(live);

		SavedAnalysis saved = remember(this.service.save(snapshot.token().toString(), "[test] 복원 확인"));
		AnalysisDetail detail = this.service.get(saved.analysisId());

		JsonNode restored = this.jsonMapper.valueToTree(detail.result());
		JsonNode expected = this.jsonMapper.valueToTree(live);
		assertThat(restored).isEqualTo(expected);
		assertThat(detail.analyzedAt()).isEqualTo(snapshot.analyzedAt());
		assertThat(detail.savedAt()).isEqualTo(saved.savedAt());
		assertThat(this.store.find(snapshot.token())).isEmpty();
	}

	@Test
	void failureInTheSecondBuildingBatchRollsBackEverything() {
		RadiusAnalysisResult valid = AnalysisFixtures.syntheticResult(800);
		List<AnalyzedBuilding> buildings = new ArrayList<>(valid.buildings());
		AnalyzedBuilding b = buildings.get(650);
		// distance_m above 1000 passes the service but violates the table's CHECK constraint (second batch).
		buildings.set(650, new AnalyzedBuilding(b.id(), b.building(), b.relation(), 1500, false, false, b.polygons()));
		RadiusAnalysisResult broken = new RadiusAnalysisResult(valid.center(), valid.radiusMeters(), valid.criterion(),
				valid.criterionDescription(), valid.distanceDescription(), valid.complete(), valid.incompleteReasons(),
				valid.reportedTotal(), valid.fetchedFeatures(), valid.fetchedPages(), valid.reportedPages(),
				valid.summary(), valid.floorStatistics(), List.copyOf(buildings), valid.source());
		AnalysisSnapshot snapshot = put(broken);
		long historyBefore = count("gis_analysis_history");
		long buildingsBefore = count("gis_analysis_building");

		assertThatThrownBy(() -> this.service.save(snapshot.token().toString(), "[test] 롤백"))
			.isInstanceOf(DataIntegrityViolationException.class);

		assertThat(this.mapper.findIdByToken(snapshot.token().toString())).isNull();
		assertThat(count("gis_analysis_history")).isEqualTo(historyBefore);
		assertThat(count("gis_analysis_building")).as("the first 500 rows were rolled back too")
			.isEqualTo(buildingsBefore);
		assertThat(this.store.find(snapshot.token())).as("token kept after rollback").isPresent();
	}

	@Test
	void concurrentSavesOfOneTokenCreateOneHistory() throws Exception {
		AnalysisSnapshot snapshot = put(AnalysisFixtures.liveResult());

		List<Object> outcomes = runConcurrently(12,
				(i) -> this.service.save(snapshot.token().toString(), "[test] 동시 " + i));

		assertThat(outcomes).filteredOn(SavedAnalysis.class::isInstance).hasSize(1);
		assertThat(outcomes).filteredOn(AnalysisHistoryException.class::isInstance)
			.hasSize(11)
			.allMatch((ex) -> ((AnalysisHistoryException) ex).getCode() == Code.ALREADY_SAVED);
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM gis_analysis_history WHERE snapshot_token = ?", Integer.class,
				snapshot.token().toString()))
			.isEqualTo(1);
	}

	/** Two application instances (separate locks) saving the same token: the unique column decides. */
	@Test
	void uniqueTokenColumnStopsDuplicatesAcrossInstances() throws Exception {
		AnalysisSnapshot snapshot = put(AnalysisFixtures.syntheticResult(1500));
		AnalysisHistoryService otherInstance = new AnalysisHistoryService(this.mapper, this.store,
				this.transactionManager, this.jsonMapper);

		List<Object> outcomes = runConcurrently(8, (i) -> ((i % 2 == 0) ? this.service : otherInstance)
			.save(snapshot.token().toString(), "[test] 인스턴스 " + i));

		assertThat(outcomes).filteredOn(SavedAnalysis.class::isInstance).hasSize(1);
		assertThat(outcomes).filteredOn((o) -> !(o instanceof SavedAnalysis))
			.hasSize(7)
			.allMatch((o) -> o instanceof AnalysisHistoryException ex && ex.getCode() == Code.ALREADY_SAVED);
		Long id = this.mapper.findIdByToken(snapshot.token().toString());
		assertThat(id).isNotNull();
		assertThat(this.mapper.findBuildings(id)).hasSize(1500);
	}

	@Test
	void fiveThousandBuildingsAreSavedAndRestored() {
		RadiusAnalysisResult result = AnalysisFixtures.syntheticResult(5000);
		AnalysisSnapshot snapshot = put(result);

		long started = System.nanoTime();
		SavedAnalysis saved = remember(this.service.save(snapshot.token().toString(), "[test] 5000건"));
		long saveMillis = (System.nanoTime() - started) / 1_000_000;
		started = System.nanoTime();
		AnalysisDetail detail = this.service.get(saved.analysisId());
		long readMillis = (System.nanoTime() - started) / 1_000_000;

		assertThat(detail.result().buildings()).hasSize(5000);
		JsonNode restoredBuildings = this.jsonMapper.valueToTree(detail.result().buildings());
		JsonNode expectedBuildings = this.jsonMapper.valueToTree(result.buildings());
		assertThat(restoredBuildings).isEqualTo(expectedBuildings);
		System.out.println("[mariadb] save 5,000 buildings " + saveMillis + " ms, restore " + readMillis + " ms");
	}

	@Test
	void historyLimitIsEnforcedInTheTransaction() {
		long existing = this.mapper.countHistory();
		int toFill = (int) (AnalysisHistoryService.MAX_HISTORY - existing);
		assertThat(toFill).as("test DB must have room for this test").isPositive();
		for (int i = 0; i < toFill; i++) {
			remember(this.service.save(put(AnalysisFixtures.syntheticResult(1)).token().toString(), "[test] 채우기 " + i));
		}
		AnalysisSnapshot oneMore = put(AnalysisFixtures.syntheticResult(1));

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.save(oneMore.token().toString(), "[test] 초과"))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.HISTORY_LIMIT));
		assertThat(this.mapper.countHistory()).isEqualTo(AnalysisHistoryService.MAX_HISTORY);
		assertThat(this.store.find(oneMore.token())).isPresent();
	}

	@Test
	void deleteRemovesEverythingOfThatAnalysisOnly() {
		SavedAnalysis first = remember(this.service.save(put(AnalysisFixtures.liveResult()).token().toString(),
				"[test] 삭제 1"));
		SavedAnalysis second = remember(this.service.save(put(AnalysisFixtures.liveResult()).token().toString(),
				"[test] 삭제 2"));

		this.service.delete(first.analysisId());

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.get(first.analysisId()))
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(Code.ANALYSIS_NOT_FOUND));
		assertThat(this.mapper.findBuildings(first.analysisId())).isEmpty();
		assertThat(this.mapper.findReasons(first.analysisId())).isEmpty();
		assertThat(this.service.get(second.analysisId()).result().buildings()).isNotEmpty();
	}

	private AnalysisSnapshot put(RadiusAnalysisResult result) {
		AnalysisSnapshot snapshot = this.store.put(result);
		this.tokens.add(snapshot.token().toString());
		return snapshot;
	}

	private SavedAnalysis remember(SavedAnalysis saved) {
		this.created.add(saved.analysisId());
		return saved;
	}

	private long count(String table) {
		return this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
	}

	private static List<Object> runConcurrently(int threads, IntFunction<Object> task) throws Exception {
		List<Object> outcomes = new CopyOnWriteArrayList<>();
		CountDownLatch start = new CountDownLatch(1);
		ExecutorService executor = Executors.newFixedThreadPool(threads);
		try {
			List<Future<?>> futures = new ArrayList<>();
			for (int t = 0; t < threads; t++) {
				int index = t;
				futures.add(executor.submit(() -> {
					start.await();
					try {
						outcomes.add(task.apply(index));
					}
					catch (AnalysisHistoryException ex) {
						outcomes.add(ex);
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<?> future : futures) {
				future.get(120, TimeUnit.SECONDS);
			}
		}
		finally {
			executor.shutdownNow();
		}
		return outcomes;
	}

}
