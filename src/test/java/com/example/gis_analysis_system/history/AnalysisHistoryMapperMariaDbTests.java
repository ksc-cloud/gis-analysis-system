package com.example.gis_analysis_system.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.databind.json.JsonMapper;

/**
 * Mapper SQL against the real gis_analysis_test database. Every test runs in a transaction that is rolled back,
 * so nothing is left behind.
 */
@Tag("mariadb")
@EnabledIfEnvironmentVariable(named = MariaDbTestDatabase.ENABLED_VARIABLE, matches = ".+")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "vworld.api-key=")
@Transactional
class AnalysisHistoryMapperMariaDbTests {

	@Autowired
	private AnalysisHistoryMapper mapper;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	private final GeometryJson geometryJson = new GeometryJson(JsonMapper.builder().build());

	@BeforeAll
	static void requireTestDatabase() {
		MariaDbTestDatabase.requireTestDatabase();
	}

	@Test
	void connectedToTheTestDatabaseWithUtf8mb4() {
		assertThat(this.jdbcTemplate.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("gis_analysis_test");
		assertThat(this.jdbcTemplate.queryForObject("SELECT @@character_set_connection", String.class))
			.isEqualTo("utf8mb4");
		assertThat(this.jdbcTemplate.queryForObject("SELECT CURRENT_USER()", String.class)).doesNotStartWith("gis_app@");
	}

	@Test
	void historyReasonsAndBuildingsRoundTripExactly() {
		HistoryRow row = historyRow(UUID.randomUUID().toString(), "서울시청 '반경' \"분석\" 🏢", 3);
		long id = insert(row);
		this.mapper.insertReasons(List.of(new ReasonRow(id, 1, "PAGE_LIMIT", "최대 5페이지까지만 조회했습니다."),
				new ReasonRow(id, 2, "COUNT_MISMATCH", "건수가 다릅니다.")));
		String geometry = this.geometryJson.write(GeometryJsonTests.buildingWithHoleAndTwoParts());
		this.mapper.insertBuildings(List.of(
				building(id, 1, "bd:1114010300100310000000001", "1114010300100310000000001", "13", 13, "INSIDE",
						"0.00", true, true, geometry),
				building(id, 2, "feature:LT_C_SPBD.2", null, "0", null, "PARTIAL", "99.99", false, false, geometry),
				building(id, 3, "row:7", null, null, null, "PARTIAL", "1000.00", false, false, geometry)));

		HistoryRow stored = this.mapper.findHistory(id);
		assertThat(stored).isEqualTo(withId(row, id));
		assertThat(this.mapper.findIdByToken(row.snapshotToken())).isEqualTo(id);
		assertThat(this.mapper.findReasons(id)).extracting(ReasonRow::reasonCode)
			.containsExactly("PAGE_LIMIT", "COUNT_MISMATCH");
		List<BuildingRow> buildings = this.mapper.findBuildings(id);
		assertThat(buildings).extracting(BuildingRow::seq).containsExactly(1, 2, 3);
		assertThat(buildings.get(0).geometry()).isEqualTo(geometry);
		assertThat(buildings.get(0).distanceM()).isEqualByComparingTo("0.00");
		assertThat(buildings.get(1).distanceM()).isEqualByComparingTo("99.99");
		assertThat(buildings.get(1).bdMgtSn()).isNull();
		assertThat(buildings.get(1).groundFloorRaw()).isEqualTo("0");
		assertThat(buildings.get(1).groundFloorCount()).isNull();
		assertThat(buildings.get(2).groundFloorRaw()).isNull();
		List<double[][][]> polygons = this.geometryJson.read(buildings.get(0).geometry());
		List<double[][][]> expected = GeometryJsonTests.buildingWithHoleAndTwoParts();
		for (int i = 0; i < expected.size(); i++) {
			assertThat(java.util.Arrays.deepEquals(polygons.get(i), expected.get(i))).isTrue();
		}
	}

	@Test
	void floorStatisticsAreAggregatedInSql() {
		long id = insert(historyRow(UUID.randomUUID().toString(), "층수", 7));
		String geometry = this.geometryJson.write(GeometryJsonTests.buildingWithHoleAndTwoParts());
		Integer[] floors = { 1, 2, 5, 10, 11, 21, null };
		List<BuildingRow> rows = new ArrayList<>();
		for (int i = 0; i < floors.length; i++) {
			rows.add(building(id, i + 1, "feature:F" + i, null, (floors[i] != null) ? floors[i].toString() : "0",
					floors[i], "INSIDE", "1.00", false, false, geometry));
		}
		this.mapper.insertBuildings(rows);

		FloorStatsRow stats = this.mapper.findFloorStats(id);

		assertThat(stats).isEqualTo(new FloorStatsRow(6, 1, 1, 21, 50, 2, 1, 1, 1, 1));
		FloorStatsRow empty = this.mapper.findFloorStats(insert(historyRow(UUID.randomUUID().toString(), "빈", 0)));
		assertThat(empty).isEqualTo(new FloorStatsRow(0, 0, null, null, 0, 0, 0, 0, 0, 0));
	}

	@Test
	void pagesAndSortsTheHistory() {
		long before = this.mapper.countHistory();
		List<Long> ids = new ArrayList<>();
		String[] titles = { "나", "가", "다" };
		int[] counts = { 5, 9, 1 };
		for (int i = 0; i < 3; i++) {
			HistoryRow row = historyRow(UUID.randomUUID().toString(), "[정렬] " + titles[i], counts[i]);
			ids.add(insert(withSavedAt(row, LocalDateTime.parse("2099-01-01T00:00:00").plusMinutes(i))));
		}

		assertThat(this.mapper.countHistory()).isEqualTo(before + 3);
		assertThat(this.mapper.findPage(HistorySort.SAVED_DESC, 3, 0)).extracting(HistorySummaryRow::analysisId)
			.containsExactly(ids.get(2), ids.get(1), ids.get(0));
		assertThat(this.mapper.findPage(HistorySort.SAVED_DESC, 1, 1)).extracting(HistorySummaryRow::analysisId)
			.containsExactly(ids.get(1));
		assertThat(this.mapper.findPage(HistorySort.TITLE_ASC, 1000, 0)).extracting(HistorySummaryRow::title)
			.containsSubsequence("[정렬] 가", "[정렬] 나", "[정렬] 다");
		assertThat(this.mapper.findPage(HistorySort.BUILDINGS_DESC, 1000, 0))
			.filteredOn((row) -> ids.contains(row.analysisId()))
			.extracting(HistorySummaryRow::intersectingCount)
			.containsExactly(9, 5, 1);
		assertThat(this.mapper.findPage(HistorySort.SAVED_ASC, 1000, 0)).extracting(HistorySummaryRow::analysisId)
			.containsSubsequence(ids.get(0), ids.get(1), ids.get(2));
	}

	@Test
	void sqlInjectionTextIsStoredAsPlainData() {
		String title = "x'); DROP TABLE gis_analysis_history; -- \\' OR '1'='1";
		long id = insert(historyRow(UUID.randomUUID().toString(), title, 0));

		assertThat(this.mapper.findHistory(id).title()).isEqualTo(title);
		assertThat(this.mapper.findIdByToken("' OR '1'='1")).isNull();
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", Integer.class))
			.isEqualTo(3);
	}

	@Test
	void duplicateTokenAndConstraintViolationsAreTranslated() {
		String token = UUID.randomUUID().toString();
		insert(historyRow(token, "첫 번째", 0));

		assertThatExceptionOfType(DuplicateKeyException.class)
			.isThrownBy(() -> insert(historyRow(token, "두 번째", 0)));
		HistoryRow inconsistent = historyRow(UUID.randomUUID().toString(), "개수 불일치", 0);
		HistoryRow broken = new HistoryRow(null, inconsistent.snapshotToken(), inconsistent.title(),
				inconsistent.centerLon(), inconsistent.centerLat(), inconsistent.radiusM(), inconsistent.criterion(), 5,
				1, 1, 0, 0, 5, 0, 5, 5, 1, 1, true, inconsistent.sourceProvider(), inconsistent.sourceLayer(),
				inconsistent.sourceCrs(), inconsistent.sourceNotice(), inconsistent.analyzedAt(), inconsistent.savedAt());
		assertThatExceptionOfType(DataIntegrityViolationException.class).isThrownBy(() -> insert(broken));
	}

	@Test
	void deleteCascadesToReasonsAndBuildings() {
		long id = insert(historyRow(UUID.randomUUID().toString(), "삭제", 1));
		this.mapper.insertReasons(List.of(new ReasonRow(id, 1, "TOTAL_UNKNOWN", "전체 건수를 알 수 없습니다.")));
		this.mapper.insertBuildings(List.of(building(id, 1, "feature:D", null, "3", 3, "INSIDE", "1.00", false, false,
				this.geometryJson.write(GeometryJsonTests.buildingWithHoleAndTwoParts()))));

		assertThat(this.mapper.deleteHistory(id)).isEqualTo(1);
		assertThat(this.mapper.deleteHistory(id)).isZero();

		assertThat(this.mapper.findHistory(id)).isNull();
		assertThat(this.mapper.findReasons(id)).isEmpty();
		assertThat(this.mapper.findBuildings(id)).isEmpty();
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT (SELECT COUNT(*) FROM gis_analysis_building WHERE analysis_id = ?)"
						+ " + (SELECT COUNT(*) FROM gis_analysis_incomplete_reason WHERE analysis_id = ?)",
				Integer.class, id, id))
			.isZero();
	}

	@Test
	void fiveThousandBuildingsInBatchesOfFiveHundred() {
		long id = insert(historyRow(UUID.randomUUID().toString(), "5000건", 5000));
		String geometry = this.geometryJson.write(GeometryJsonTests.buildingWithHoleAndTwoParts());
		long started = System.nanoTime();
		for (int batch = 0; batch < 10; batch++) {
			List<BuildingRow> rows = new ArrayList<>();
			for (int i = 1; i <= 500; i++) {
				int seq = batch * 500 + i;
				rows.add(building(id, seq, "feature:B" + seq, null, String.valueOf(seq % 40), (seq % 40 == 0) ? null
						: seq % 40, (seq % 2 == 0) ? "INSIDE" : "PARTIAL", "12.34", false, true, geometry));
			}
			this.mapper.insertBuildings(rows);
		}
		long insertMillis = (System.nanoTime() - started) / 1_000_000;
		started = System.nanoTime();
		List<BuildingRow> stored = this.mapper.findBuildings(id);
		long readMillis = (System.nanoTime() - started) / 1_000_000;

		assertThat(stored).hasSize(5000);
		assertThat(stored.get(4999).seq()).isEqualTo(5000);
		assertThat(stored).allMatch((row) -> row.geometry().equals(geometry));
		System.out.println("[mariadb] 5,000 buildings: insert " + insertMillis + " ms, read " + readMillis + " ms");
	}

	private long insert(HistoryRow row) {
		HistoryInsert insert = new HistoryInsert(row);
		this.mapper.insertHistory(insert);
		assertThat(insert.getAnalysisId()).isPositive();
		return insert.getAnalysisId();
	}

	static HistoryRow historyRow(String token, String title, int intersecting) {
		return new HistoryRow(null, token, title, 126.97797, 37.5665012345678, 500, "POLYGON_INTERSECTS_CIRCLE",
				intersecting, intersecting, 0, 2, 1, intersecting + 3, 4, intersecting + 7, intersecting + 7, 1, 1, true,
				"VWorld 2D 데이터 API", "LT_C_SPBD (도로명주소 건물)", "EPSG:4326 (WGS84 경위도)", "출처 안내",
				LocalDateTime.parse("2026-10-11T03:00:00.123"), LocalDateTime.parse("2026-10-11T03:00:05.456"));
	}

	private static HistoryRow withSavedAt(HistoryRow row, LocalDateTime savedAt) {
		return new HistoryRow(row.analysisId(), row.snapshotToken(), row.title(), row.centerLon(), row.centerLat(),
				row.radiusM(), row.criterion(), row.intersectingCount(), row.insideCount(), row.partialCount(),
				row.outsideExcludedCount(), row.geometryUnavailableCount(), row.distinctBuildingCount(),
				row.mergedDuplicateCount(), row.reportedTotal(), row.fetchedFeatures(), row.fetchedPages(),
				row.reportedPages(), row.complete(), row.sourceProvider(), row.sourceLayer(), row.sourceCrs(),
				row.sourceNotice(), row.analyzedAt(), savedAt);
	}

	private static HistoryRow withId(HistoryRow row, long id) {
		return new HistoryRow(id, row.snapshotToken(), row.title(), row.centerLon(), row.centerLat(), row.radiusM(),
				row.criterion(), row.intersectingCount(), row.insideCount(), row.partialCount(),
				row.outsideExcludedCount(), row.geometryUnavailableCount(), row.distinctBuildingCount(),
				row.mergedDuplicateCount(), row.reportedTotal(), row.fetchedFeatures(), row.fetchedPages(),
				row.reportedPages(), row.complete(), row.sourceProvider(), row.sourceLayer(), row.sourceCrs(),
				row.sourceNotice(), row.analyzedAt(), row.savedAt());
	}

	private static BuildingRow building(long id, int seq, String key, String managementNumber, String rawFloors,
			Integer floors, String relation, String distance, boolean centerInside, boolean hasHoles, String geometry) {
		return new BuildingRow(id, seq, key, managementNumber, "건물 " + seq, null, "서울특별시", "중구", "태평로1가", "세종대로",
				"110", rawFloors, floors, relation, new BigDecimal(distance), centerInside, hasHoles, geometry);
	}

}
