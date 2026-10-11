package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.ReasonCode;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.history.AnalysisHistoryService.HistoryPage;
import com.example.gis_analysis_system.history.AnalysisHistoryService.SavedAnalysis;
import com.example.gis_analysis_system.history.AnalysisSnapshotStoreTests.MutableClock;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class AnalysisHistoryServiceTests {

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	private final MutableClock clock = new MutableClock(Instant.parse("2026-10-11T03:00:00.000Z"));

	private final AnalysisSnapshotStore store = new AnalysisSnapshotStore(this.clock);

	private final FakeAnalysisHistoryMapper mapper = new FakeAnalysisHistoryMapper();

	private final RecordingTransactionManager transactionManager = new RecordingTransactionManager(this.mapper);

	private final AnalysisHistoryService service = new AnalysisHistoryService(this.mapper, this.store,
			this.transactionManager, this.jsonMapper, this.clock);

	@Test
	void savesHistoryReasonsAndBuildingsAndRemovesTheTokenAfterCommit() {
		RadiusAnalysisResult result = AnalysisFixtures.liveResult();
		AnalysisSnapshot snapshot = this.store.put(result);
		this.clock.advance(java.time.Duration.ofSeconds(5));
		AtomicBoolean tokenPresentAtCommit = new AtomicBoolean();
		this.transactionManager.beforeCommit = () -> tokenPresentAtCommit
			.set(this.store.find(snapshot.token()).isPresent());

		SavedAnalysis saved = this.service.save(snapshot.token().toString().toUpperCase(), "  서울시청 반경 100m  ");

		assertThat(tokenPresentAtCommit).as("token must survive until the commit").isTrue();
		assertThat(this.store.find(snapshot.token())).as("token removed after the commit").isEmpty();
		assertThat(this.transactionManager.events).containsExactly("begin", "commit");
		assertThat(saved.title()).isEqualTo("서울시청 반경 100m");
		assertThat(saved.buildingCount()).isEqualTo(result.summary().intersecting());
		assertThat(saved.savedAt()).isEqualTo(Instant.parse("2026-10-11T03:00:05Z"));

		HistoryRow row = this.mapper.history.get(saved.analysisId());
		assertThat(row.snapshotToken()).isEqualTo(snapshot.token().toString());
		assertThat(row.analyzedAt()).isEqualTo(LocalDateTime.parse("2026-10-11T03:00:00"));
		assertThat(row.savedAt()).isEqualTo(LocalDateTime.parse("2026-10-11T03:00:05"));
		assertThat(row.complete()).isFalse();
		assertThat(row.reportedTotal()).isEqualTo(7000);
		assertThat(row.intersectingCount()).isEqualTo(row.insideCount() + row.partialCount());
		assertThat(this.mapper.reasons).extracting(ReasonRow::reasonCode).contains(ReasonCode.PAGE_LIMIT.name());
		assertThat(this.mapper.reasons).extracting(ReasonRow::seq)
			.containsExactlyElementsOf(seq(this.mapper.reasons.size()));

		assertThat(this.mapper.buildings).hasSize(result.buildings().size());
		BuildingRow cityHall = this.mapper.buildings.get(0);
		assertThat(cityHall.buildingKey()).isEqualTo("bd:1114010300100310000000001");
		assertThat(cityHall.bdMgtSn()).isEqualTo("1114010300100310000000001");
		assertThat(cityHall.centerInside()).isTrue();
		assertThat(cityHall.distanceM()).isEqualByComparingTo(BigDecimal.ZERO);
		assertThat(cityHall.hasHoles()).isTrue();
		assertThat(cityHall.groundFloorRaw()).isEqualTo("13");
		assertThat(cityHall.groundFloorCount()).isEqualTo(13);
		assertThat(cityHall.geometry()).startsWith("{\"type\":\"MultiPolygon\",\"coordinates\":[[[[");
		BuildingRow partial = this.mapper.buildings.stream()
			.filter((b) -> b.buildingKey().equals("feature:LT_C_SPBD.2"))
			.findFirst()
			.orElseThrow();
		assertThat(partial.bdMgtSn()).isNull();
		assertThat(partial.relation()).isEqualTo("PARTIAL");
		assertThat(partial.groundFloorRaw()).isEqualTo("0");
		assertThat(partial.groundFloorCount()).as("0 floors = no data").isNull();
		assertThat(this.mapper.buildings).extracting(BuildingRow::buildingKey).anyMatch((key) -> key.startsWith("row:"));
		assertThat(this.mapper.buildings).extracting(BuildingRow::relation).doesNotContain("OUTSIDE");
	}

	/** The detail has exactly the live JSON (same fields, values, coordinates, holes and floor statistics). */
	@Test
	void restoredResultIsIdenticalToTheLiveResult() {
		RadiusAnalysisResult live = AnalysisFixtures.liveResult();
		AnalysisSnapshot snapshot = this.store.put(live);
		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "복원 확인");

		AnalysisDetail detail = this.service.get(saved.analysisId());

		assertThat(detail.title()).isEqualTo("복원 확인");
		assertThat(detail.analyzedAt()).isEqualTo(snapshot.analyzedAt());
		assertThat(detail.savedAt()).isEqualTo(saved.savedAt());
		JsonNode restored = this.jsonMapper.valueToTree(detail.result());
		JsonNode expected = this.jsonMapper.valueToTree(live);
		assertThat(restored).isEqualTo(expected);
		assertThat(detail.result().buildings().get(0).polygons().get(0)).hasNumberOfRows(2);
		assertThat(this.transactionManager.events).endsWith("begin-read", "commit");
	}

	@Test
	void insertsBuildingsInBatchesOfFiveHundred() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.syntheticResult(1201));

		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "대량 저장");

		assertThat(this.mapper.buildingBatchSizes).containsExactly(500, 500, 201);
		assertThat(this.mapper.buildings).extracting(BuildingRow::seq).containsExactlyElementsOf(seq(1201));
		assertThat(this.mapper.buildings).allMatch((b) -> b.analysisId() == saved.analysisId());
		AnalysisDetail detail = this.service.get(saved.analysisId());
		assertThat(detail.result().buildings()).hasSize(1201);
	}

	@Test
	void secondSaveOfTheSameTokenIsAlreadySaved() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "첫 저장");

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.save(snapshot.token().toString(), "다시 저장"))
			.satisfies((ex) -> {
				assertThat(ex.getCode()).isEqualTo(Code.ALREADY_SAVED);
				assertThat(ex.getAnalysisId()).isEqualTo(saved.analysisId());
			});
		assertThat(this.mapper.history).hasSize(1);
	}

	@Test
	void savedTokenIsRecognizedEvenWhenTheSnapshotIsGone() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "첫 저장");
		AnalysisHistoryService afterRestart = new AnalysisHistoryService(this.mapper,
				new AnalysisSnapshotStore(this.clock), this.transactionManager, this.jsonMapper, this.clock);

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> afterRestart.save(snapshot.token().toString(), "재시작 후"))
			.satisfies((ex) -> assertThat(ex.getAnalysisId()).isEqualTo(saved.analysisId()));
	}

	@Test
	void unknownOrExpiredTokenIsSnapshotExpired() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		this.clock.advance(AnalysisSnapshotStore.TTL);

		expectCode(() -> this.service.save(snapshot.token().toString(), "만료"), Code.SNAPSHOT_EXPIRED);
		expectCode(() -> this.service.save(UUID.randomUUID().toString(), "없음"), Code.SNAPSHOT_EXPIRED);
		assertThat(this.mapper.insertHistoryCalls).hasValue(0);
		assertThat(this.transactionManager.events).isEmpty();
	}

	@Test
	void historyLimitRollsBackAndKeepsTheToken() {
		this.mapper.existingRows = AnalysisHistoryService.MAX_HISTORY;
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());

		expectCode(() -> this.service.save(snapshot.token().toString(), "상한"), Code.HISTORY_LIMIT);

		assertThat(this.transactionManager.events).containsExactly("begin", "rollback");
		assertThat(this.mapper.insertHistoryCalls).hasValue(0);
		assertThat(this.store.find(snapshot.token())).isPresent();
	}

	@Test
	void failureInALaterBatchRollsBackEverythingAndTheTokenCanBeRetried() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.syntheticResult(1201));
		this.mapper.failOnBuildingBatch = 2;

		assertThatThrownBy(() -> this.service.save(snapshot.token().toString(), "실패"))
			.isInstanceOf(DataIntegrityViolationException.class);

		assertThat(this.transactionManager.events).containsExactly("begin", "rollback");
		assertThat(this.mapper.history).isEmpty();
		assertThat(this.mapper.buildings).isEmpty();
		assertThat(this.store.find(snapshot.token())).as("token kept after rollback").isPresent();

		this.mapper.failOnBuildingBatch = 0;
		SavedAnalysis retried = this.service.save(snapshot.token().toString(), "재시도");
		assertThat(this.mapper.history).containsOnlyKeys(retried.analysisId());
		assertThat(this.mapper.buildings).hasSize(1201);
		assertThat(this.store.find(snapshot.token())).isEmpty();
	}

	@Test
	void duplicateKeyFromAnotherInstanceIsAlreadySaved() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		this.mapper.simulateOtherInstanceSaved = 77L;

		assertThatExceptionOfType(AnalysisHistoryException.class)
			.isThrownBy(() -> this.service.save(snapshot.token().toString(), "경쟁"))
			.satisfies((ex) -> {
				assertThat(ex.getCode()).isEqualTo(Code.ALREADY_SAVED);
				assertThat(ex.getAnalysisId()).isEqualTo(77L);
			});
	}

	@Test
	void concurrentSavesOfOneTokenCreateExactlyOneHistory() throws Exception {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		List<Object> outcomes = runConcurrently(16, (i) -> this.service.save(snapshot.token().toString(), "동시 " + i));

		assertThat(outcomes).filteredOn(SavedAnalysis.class::isInstance).hasSize(1);
		assertThat(outcomes).filteredOn(AnalysisHistoryException.class::isInstance)
			.hasSize(15)
			.allMatch((ex) -> ((AnalysisHistoryException) ex).getCode() == Code.ALREADY_SAVED);
		assertThat(this.mapper.history).hasSize(1);
		assertThat(this.mapper.insertHistoryCalls).hasValue(1);
	}

	@Test
	void concurrentSavesNeverExceedTheHistoryLimit() throws Exception {
		this.mapper.existingRows = AnalysisHistoryService.MAX_HISTORY - 3;
		List<AnalysisSnapshot> snapshots = new ArrayList<>();
		for (int i = 0; i < 8; i++) {
			snapshots.add(this.store.put(AnalysisFixtures.liveResult()));
		}
		List<Object> outcomes = runConcurrently(8,
				(i) -> this.service.save(snapshots.get(i).token().toString(), "상한 경쟁 " + i));

		assertThat(outcomes).filteredOn(SavedAnalysis.class::isInstance).hasSize(3);
		assertThat(outcomes).filteredOn(AnalysisHistoryException.class::isInstance)
			.hasSize(5)
			.allMatch((ex) -> ((AnalysisHistoryException) ex).getCode() == Code.HISTORY_LIMIT);
		assertThat(this.mapper.countHistory()).isEqualTo(AnalysisHistoryService.MAX_HISTORY);
	}

	@Test
	void validatesTokenAndTitleBeforeTouchingTheDatabase() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		String token = snapshot.token().toString();
		for (String bad : new String[] { null, "", "abc", token + "x", "' OR 1=1 --", token.replace('-', '_') }) {
			expectCode(() -> this.service.save(bad, "제목"), Code.INVALID_TOKEN);
		}
		String hundredKorean = "가".repeat(100);
		String hundredEmoji = "🏢".repeat(100);
		for (String bad : new String[] { null, "", "   ", "\t\n", "가".repeat(101), "🏢".repeat(101),
				"줄\n바꿈", "탭\t문자", "널\u0000문자", "깨진\uD800문자" }) {
			expectCode(() -> this.service.save(token, bad), Code.INVALID_TITLE);
		}
		assertThat(this.mapper.insertHistoryCalls).hasValue(0);
		assertThat(AnalysisHistoryService.normalizeTitle(hundredKorean)).hasSize(100);
		assertThat(AnalysisHistoryService.normalizeTitle(hundredEmoji)).hasSize(200);
		assertThat(AnalysisHistoryService.normalizeTitle("x'); DROP TABLE gis_analysis_history; --"))
			.isEqualTo("x'); DROP TABLE gis_analysis_history; --");
	}

	@Test
	void listPagesAndValidatesItsArguments() {
		for (int i = 0; i < 3; i++) {
			this.clock.advance(java.time.Duration.ofMinutes(1));
			AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.syntheticResult(i + 1));
			this.service.save(snapshot.token().toString(), "이력 " + i);
		}

		HistoryPage first = this.service.list(1, 2, null);
		HistoryPage second = this.service.list(2, 2, HistorySort.SAVED_DESC);
		HistoryPage byBuildings = this.service.list(1, 50, HistorySort.BUILDINGS_DESC);
		HistoryPage beyond = this.service.list(9, 2, HistorySort.SAVED_ASC);

		assertThat(first.items()).extracting(AnalysisHistoryService.HistoryItem::title).containsExactly("이력 2", "이력 1");
		assertThat(first.totalItems()).isEqualTo(3);
		assertThat(first.totalPages()).isEqualTo(2);
		assertThat(first.maxHistory()).isEqualTo(500);
		assertThat(second.items()).extracting(AnalysisHistoryService.HistoryItem::title).containsExactly("이력 0");
		assertThat(byBuildings.items()).extracting(AnalysisHistoryService.HistoryItem::buildingCount)
			.containsExactly(3, 2, 1);
		assertThat(beyond.items()).isEmpty();
		assertThat(first.items().get(0).savedAt()).isAfter(first.items().get(1).savedAt());

		for (int[] bad : new int[][] { { 0, 20 }, { -1, 20 }, { 1, 0 }, { 1, 51 }, { 10_001, 20 } }) {
			expectCode(() -> this.service.list(bad[0], bad[1], null), Code.INVALID_PAGE);
		}
	}

	@Test
	void getAndDeleteReportMissingAnalyses() {
		expectCode(() -> this.service.get(12345), Code.ANALYSIS_NOT_FOUND);
		expectCode(() -> this.service.delete(12345), Code.ANALYSIS_NOT_FOUND);
		expectCode(() -> this.service.get(0), Code.INVALID_ID);
		expectCode(() -> this.service.delete(-5), Code.INVALID_ID);
	}

	@Test
	void deleteRemovesTheAnalysisWithItsRows() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "삭제 대상");

		this.service.delete(saved.analysisId());

		assertThat(this.mapper.history).isEmpty();
		assertThat(this.mapper.reasons).isEmpty();
		assertThat(this.mapper.buildings).isEmpty();
		expectCode(() -> this.service.get(saved.analysisId()), Code.ANALYSIS_NOT_FOUND);
	}

	@Test
	void unreadableStoredGeometryIsReportedAsStoredDataInvalid() {
		AnalysisSnapshot snapshot = this.store.put(AnalysisFixtures.liveResult());
		SavedAnalysis saved = this.service.save(snapshot.token().toString(), "손상");
		BuildingRow first = this.mapper.buildings.get(0);
		this.mapper.buildings.set(0, new BuildingRow(first.analysisId(), first.seq(), first.buildingKey(),
				first.bdMgtSn(), first.buildingName(), first.buildingSubName(), first.sido(), first.sigungu(),
				first.eupmyeon(), first.roadName(), first.buildingNumber(), first.groundFloorRaw(),
				first.groundFloorCount(), first.relation(), first.distanceM(), first.centerInside(), first.hasHoles(),
				"{\"type\":\"Point\",\"coordinates\":[1,2]}"));

		expectCode(() -> this.service.get(saved.analysisId()), Code.STORED_DATA_INVALID);
	}

	@Test
	void rejectsResultsTheTablesCannotHold() {
		RadiusAnalysisResult live = AnalysisFixtures.liveResult();
		var building = live.buildings().get(0);
		var outside = new RadiusAnalysisResult.AnalyzedBuilding(building.id(), building.building(), Relation.OUTSIDE,
				building.distanceMeters(), false, building.hasHoles(), building.polygons());
		RadiusAnalysisResult withOutside = new RadiusAnalysisResult(live.center(), live.radiusMeters(),
				live.criterion(), live.criterionDescription(), live.distanceDescription(), live.complete(),
				live.incompleteReasons(), live.reportedTotal(), live.fetchedFeatures(), live.fetchedPages(),
				live.reportedPages(), live.summary(), live.floorStatistics(), List.of(outside), live.source());
		AnalysisSnapshot snapshot = this.store.put(withOutside);

		expectCode(() -> this.service.save(snapshot.token().toString(), "밖"), Code.UNSUPPORTED_RESULT);
		assertThat(this.transactionManager.events).isEmpty();
	}

	@Test
	void fitShortensFreeTextByCodePoints() {
		assertThat(AnalysisHistoryService.fit(null, 3)).isNull();
		assertThat(AnalysisHistoryService.fit("가나다", 3)).isEqualTo("가나다");
		assertThat(AnalysisHistoryService.fit("가나다라", 3)).isEqualTo("가나다");
		assertThat(AnalysisHistoryService.fit("🏢🏢", 1)).isEqualTo("🏢");
	}

	private static List<Integer> seq(int count) {
		List<Integer> values = new ArrayList<>();
		for (int i = 1; i <= count; i++) {
			values.add(i);
		}
		return values;
	}

	private static void expectCode(Runnable action, Code code) {
		assertThatExceptionOfType(AnalysisHistoryException.class).isThrownBy(action::run)
			.satisfies((ex) -> assertThat(ex.getCode()).isEqualTo(code));
	}

	private static List<Object> runConcurrently(int threads, java.util.function.IntFunction<Object> task)
			throws Exception {
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
				future.get(60, TimeUnit.SECONDS);
			}
		}
		finally {
			executor.shutdownNow();
		}
		return outcomes;
	}

}
