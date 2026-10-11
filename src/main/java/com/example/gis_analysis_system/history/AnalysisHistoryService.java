package com.example.gis_analysis_system.history;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Center;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.DataSource;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.FloorStatistics;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.IncompleteReason;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.ReasonCode;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Summary;
import com.example.gis_analysis_system.analysis.RadiusAnalysisService;
import com.example.gis_analysis_system.history.AnalysisHistoryException.Code;
import com.example.gis_analysis_system.vworld.BuildingInfo;

import tools.jackson.databind.json.JsonMapper;

/**
 * Saves radius analysis results kept in {@link AnalysisSnapshotStore} to MariaDB and reads them back in the same
 * shape as a live result, without calling VWorld again.
 * <p>
 * A save is one transaction (history row, reasons, buildings in batches); any failure rolls everything back and the
 * token stays usable. The token is removed only after the commit succeeded. Saves are serialized in this instance so
 * the history limit and the duplicate check cannot race; the unique token column guards across instances.
 */
@Service
public class AnalysisHistoryService {

	public static final int MAX_HISTORY = 500;

	public static final int MAX_TITLE_LENGTH = 100;

	public static final int DEFAULT_PAGE_SIZE = 20;

	public static final int MAX_PAGE_SIZE = 50;

	static final int MAX_PAGE = 10_000;

	static final int BUILDING_BATCH_SIZE = 500;

	/** Also split a batch before its geometries reach this many characters (max_allowed_packet is 16 MB). */
	static final int BATCH_GEOMETRY_CHARS = 4_000_000;

	static final int MAX_GEOMETRY_CHARS = 500_000;

	private static final Pattern TOKEN = Pattern
		.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

	private final AnalysisHistoryMapper mapper;

	private final AnalysisSnapshotStore snapshotStore;

	private final TransactionTemplate writeTransaction;

	private final TransactionTemplate readTransaction;

	private final GeometryJson geometryJson;

	private final Clock clock;

	private final Object saveLock = new Object();

	@Autowired
	public AnalysisHistoryService(AnalysisHistoryMapper mapper, AnalysisSnapshotStore snapshotStore,
			PlatformTransactionManager transactionManager, JsonMapper jsonMapper) {
		this(mapper, snapshotStore, transactionManager, jsonMapper, Clock.systemUTC());
	}

	AnalysisHistoryService(AnalysisHistoryMapper mapper, AnalysisSnapshotStore snapshotStore,
			PlatformTransactionManager transactionManager, JsonMapper jsonMapper, Clock clock) {
		this.mapper = mapper;
		this.snapshotStore = snapshotStore;
		this.writeTransaction = new TransactionTemplate(transactionManager);
		this.readTransaction = new TransactionTemplate(transactionManager);
		this.readTransaction.setReadOnly(true);
		this.geometryJson = new GeometryJson(jsonMapper);
		this.clock = clock;
	}

	// ----------------------------------------------------------------- save

	public SavedAnalysis save(String analysisToken, String title) {
		String token = normalizeToken(analysisToken);
		String normalizedTitle = normalizeTitle(title);
		synchronized (this.saveLock) {
			Long existing = this.mapper.findIdByToken(token);
			if (existing != null) {
				throw alreadySaved(existing);
			}
			AnalysisSnapshot snapshot = this.snapshotStore.find(UUID.fromString(token)).orElse(null);
			if (snapshot == null) {
				// Another instance may have saved it and removed the snapshot between the two checks.
				Long savedMeanwhile = this.mapper.findIdByToken(token);
				if (savedMeanwhile != null) {
					throw alreadySaved(savedMeanwhile);
				}
				throw new AnalysisHistoryException(Code.SNAPSHOT_EXPIRED,
						"저장할 분석 결과가 만료되었거나 없습니다. 반경 분석을 다시 실행한 뒤 저장하세요.");
			}
			RadiusAnalysisResult result = snapshot.result();
			// saved_at >= analyzed_at is a table constraint; never let a clock adjustment break it.
			Instant now = now();
			Instant savedAt = now.isBefore(snapshot.analyzedAt()) ? snapshot.analyzedAt() : now;
			HistoryRow historyRow = historyRow(token, normalizedTitle, result, snapshot.analyzedAt(), savedAt);
			List<BuildingRow> buildingRows = buildingRows(result.buildings());
			long analysisId;
			try {
				analysisId = this.writeTransaction.execute((status) -> insert(historyRow, result, buildingRows));
			}
			catch (DuplicateKeyException ex) {
				// Another application instance saved the same token first.
				Long winner = this.mapper.findIdByToken(token);
				if (winner == null) {
					throw ex;
				}
				throw alreadySaved(winner);
			}
			// Only reached after the commit; a failed save keeps the token so it can be retried.
			this.snapshotStore.remove(snapshot);
			return new SavedAnalysis(analysisId, normalizedTitle, savedAt, result.summary().intersecting());
		}
	}

	private long insert(HistoryRow historyRow, RadiusAnalysisResult result, List<BuildingRow> buildingRows) {
		if (this.mapper.countHistory() >= MAX_HISTORY) {
			throw new AnalysisHistoryException(Code.HISTORY_LIMIT, "분석 이력은 최대 " + MAX_HISTORY
					+ "건까지 저장할 수 있습니다. 필요 없는 이력을 삭제한 뒤 다시 저장하세요.");
		}
		HistoryInsert insert = new HistoryInsert(historyRow);
		this.mapper.insertHistory(insert);
		long analysisId = insert.getAnalysisId();

		List<ReasonRow> reasons = new ArrayList<>();
		for (IncompleteReason reason : result.incompleteReasons()) {
			reasons.add(new ReasonRow(analysisId, reasons.size() + 1, reason.code().name(), fit(reason.message(), 300)));
		}
		if (!reasons.isEmpty()) {
			this.mapper.insertReasons(reasons);
		}

		List<BuildingRow> batch = new ArrayList<>();
		int batchChars = 0;
		for (BuildingRow row : buildingRows) {
			if (batch.size() == BUILDING_BATCH_SIZE
					|| (!batch.isEmpty() && batchChars + row.geometry().length() > BATCH_GEOMETRY_CHARS)) {
				this.mapper.insertBuildings(batch);
				batch = new ArrayList<>();
				batchChars = 0;
			}
			batch.add(withAnalysisId(row, analysisId));
			batchChars += row.geometry().length();
		}
		if (!batch.isEmpty()) {
			this.mapper.insertBuildings(batch);
		}
		return analysisId;
	}

	private static HistoryRow historyRow(String token, String title, RadiusAnalysisResult result, Instant analyzedAt,
			Instant savedAt) {
		Summary summary = result.summary();
		DataSource source = result.source();
		return new HistoryRow(null, token, title, result.center().lon(), result.center().lat(), result.radiusMeters(),
				result.criterion(), summary.intersecting(), summary.inside(), summary.partial(),
				summary.outsideExcluded(), summary.geometryUnavailable(), summary.distinctBuildings(),
				summary.mergedDuplicateFeatures(), result.reportedTotal(), result.fetchedFeatures(),
				result.fetchedPages(), result.reportedPages(), result.complete(), fit(source.provider(), 100),
				fit(source.layer(), 100), fit(source.coordinateSystem(), 50), fit(source.notice(), 300),
				toUtc(analyzedAt), toUtc(savedAt));
	}

	/** Rows without the analysis id yet; values the tables cannot hold are rejected before anything is written. */
	private List<BuildingRow> buildingRows(List<AnalyzedBuilding> buildings) {
		List<BuildingRow> rows = new ArrayList<>(buildings.size());
		for (AnalyzedBuilding building : buildings) {
			BuildingInfo info = building.building();
			String key = building.id();
			String managementNumber = key.startsWith("bd:") ? info.buildingManagementNumber() : null;
			if (key.length() > 80 || (managementNumber != null && managementNumber.length() > 30)) {
				throw unsupported("건물 식별자가 너무 깁니다.");
			}
			if (building.relation() == Relation.OUTSIDE) {
				throw unsupported("반경 밖 건물은 저장하지 않습니다.");
			}
			String geometry = this.geometryJson.write(building.polygons());
			if (geometry.length() > MAX_GEOMETRY_CHARS) {
				throw unsupported("건물 도형이 너무 커서 저장할 수 없습니다.");
			}
			rows.add(new BuildingRow(0, rows.size() + 1, key, managementNumber, fit(info.buildingName(), 200),
					fit(info.buildingSubName(), 200), fit(info.sido(), 40), fit(info.sigungu(), 40),
					fit(info.eupmyeon(), 40), fit(info.roadName(), 80), fit(info.buildingNumber(), 20),
					fit(info.groundFloorCount(), 10), RadiusAnalysisService.validFloors(info.groundFloorCount()),
					building.relation().name(), BigDecimal.valueOf(building.distanceMeters()), building.centerInside(),
					building.hasHoles(), geometry));
		}
		return rows;
	}

	private static BuildingRow withAnalysisId(BuildingRow row, long analysisId) {
		return new BuildingRow(analysisId, row.seq(), row.buildingKey(), row.bdMgtSn(), row.buildingName(),
				row.buildingSubName(), row.sido(), row.sigungu(), row.eupmyeon(), row.roadName(), row.buildingNumber(),
				row.groundFloorRaw(), row.groundFloorCount(), row.relation(), row.distanceM(), row.centerInside(),
				row.hasHoles(), row.geometry());
	}

	// ----------------------------------------------------------------- list / detail / delete

	public HistoryPage list(int page, int size, HistorySort sort) {
		if (page < 1 || page > MAX_PAGE || size < 1 || size > MAX_PAGE_SIZE) {
			throw new AnalysisHistoryException(Code.INVALID_PAGE,
					"page는 1~" + MAX_PAGE + ", size는 1~" + MAX_PAGE_SIZE + " 사이의 정수여야 합니다.");
		}
		HistorySort order = (sort != null) ? sort : HistorySort.SAVED_DESC;
		return this.readTransaction.execute((status) -> {
			long total = this.mapper.countHistory();
			List<HistoryItem> items = new ArrayList<>();
			for (HistorySummaryRow row : this.mapper.findPage(order, size, (long) (page - 1) * size)) {
				items.add(new HistoryItem(row.analysisId(), row.title(), row.radiusM(),
						new Center(row.centerLon(), row.centerLat()), row.intersectingCount(), row.complete(),
						toInstant(row.analyzedAt()), toInstant(row.savedAt())));
			}
			int totalPages = (int) ((total + size - 1) / size);
			return new HistoryPage(List.copyOf(items), page, size, total, totalPages, MAX_HISTORY);
		});
	}

	public AnalysisDetail get(long analysisId) {
		requireValidId(analysisId);
		return this.readTransaction.execute((status) -> {
			HistoryRow history = this.mapper.findHistory(analysisId);
			if (history == null) {
				throw notFound();
			}
			try {
				List<IncompleteReason> reasons = new ArrayList<>();
				for (ReasonRow row : this.mapper.findReasons(analysisId)) {
					reasons.add(new IncompleteReason(ReasonCode.valueOf(row.reasonCode()), row.message()));
				}
				List<AnalyzedBuilding> buildings = new ArrayList<>();
				for (BuildingRow row : this.mapper.findBuildings(analysisId)) {
					buildings.add(analyzedBuilding(row));
				}
				FloorStatistics floorStatistics = floorStatistics(this.mapper.findFloorStats(analysisId));
				RadiusAnalysisResult result = new RadiusAnalysisResult(
						new Center(history.centerLon(), history.centerLat()), history.radiusM(), history.criterion(),
						RadiusAnalysisService.CRITERION_DESCRIPTION, RadiusAnalysisService.DISTANCE_DESCRIPTION,
						history.complete(), List.copyOf(reasons), history.reportedTotal(), history.fetchedFeatures(),
						history.fetchedPages(), history.reportedPages(),
						new Summary(history.intersectingCount(), history.insideCount(), history.partialCount(),
								history.outsideExcludedCount(), history.geometryUnavailableCount(),
								history.distinctBuildingCount(), history.mergedDuplicateCount()),
						floorStatistics, List.copyOf(buildings), new DataSource(history.sourceProvider(),
								history.sourceLayer(), history.sourceCrs(), history.sourceNotice()));
				return new AnalysisDetail(history.analysisId(), history.title(), toInstant(history.analyzedAt()),
						toInstant(history.savedAt()), result);
			}
			catch (IllegalArgumentException | IllegalStateException ex) {
				throw new AnalysisHistoryException(Code.STORED_DATA_INVALID, "저장된 분석 결과를 읽을 수 없습니다.");
			}
		});
	}

	public void delete(long analysisId) {
		requireValidId(analysisId);
		if (this.mapper.deleteHistory(analysisId) == 0) {
			throw notFound();
		}
	}

	private AnalyzedBuilding analyzedBuilding(BuildingRow row) {
		BuildingInfo info = new BuildingInfo(row.bdMgtSn(), row.buildingName(), row.buildingSubName(),
				row.groundFloorRaw(), row.sido(), row.sigungu(), row.eupmyeon(), row.roadName(), row.buildingNumber());
		return new AnalyzedBuilding(row.buildingKey(), info, Relation.valueOf(row.relation()),
				row.distanceM().doubleValue(), row.centerInside(), row.hasHoles(), this.geometryJson.read(row.geometry()));
	}

	private static FloorStatistics floorStatistics(FloorStatsRow row) {
		return RadiusAnalysisService.floorStatistics(row.withData(), row.withoutData(), row.minFloor(), row.maxFloor(),
				row.floorSum(), new int[] { row.bucket1To2(), row.bucket3To5(), row.bucket6To10(), row.bucket11To20(),
						row.bucket21Plus() });
	}

	// ----------------------------------------------------------------- helpers

	static String normalizeToken(String value) {
		if (value == null || !TOKEN.matcher(value).matches()) {
			throw new AnalysisHistoryException(Code.INVALID_TOKEN, "analysisToken이 올바르지 않습니다. 반경 분석 응답의 값을 사용하세요.");
		}
		return value.toLowerCase(Locale.ROOT);
	}

	/** Trimmed title of 1~100 characters (code points, like the DB's CHAR_LENGTH) without control characters. */
	static String normalizeTitle(String value) {
		String title = (value == null) ? "" : value.strip();
		int length = title.codePointCount(0, title.length());
		boolean valid = length >= 1 && length <= MAX_TITLE_LENGTH
				&& title.codePoints().noneMatch((cp) -> Character.isISOControl(cp) || Character.getType(cp) == Character.SURROGATE);
		if (!valid) {
			throw new AnalysisHistoryException(Code.INVALID_TITLE,
					"제목은 공백을 제외하고 1~" + MAX_TITLE_LENGTH + "자여야 하며 제어 문자를 포함할 수 없습니다.");
		}
		return title;
	}

	private static void requireValidId(long analysisId) {
		if (analysisId < 1) {
			throw new AnalysisHistoryException(Code.INVALID_ID, "분석 이력 ID는 1 이상의 정수여야 합니다.");
		}
	}

	/** Shortens free text to the column length (code points); identifiers are never shortened. */
	static String fit(String value, int maxLength) {
		if (value == null || value.codePointCount(0, value.length()) <= maxLength) {
			return value;
		}
		return value.substring(0, value.offsetByCodePoints(0, maxLength));
	}

	private Instant now() {
		return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}

	private static LocalDateTime toUtc(Instant instant) {
		return LocalDateTime.ofInstant(instant, ZoneOffset.UTC);
	}

	private static Instant toInstant(LocalDateTime utc) {
		return utc.toInstant(ZoneOffset.UTC);
	}

	private static AnalysisHistoryException alreadySaved(long analysisId) {
		return new AnalysisHistoryException(Code.ALREADY_SAVED, "이 분석 결과는 이미 저장되었습니다.", analysisId);
	}

	private static AnalysisHistoryException notFound() {
		return new AnalysisHistoryException(Code.ANALYSIS_NOT_FOUND, "분석 이력을 찾을 수 없습니다.");
	}

	private static AnalysisHistoryException unsupported(String message) {
		return new AnalysisHistoryException(Code.UNSUPPORTED_RESULT, message);
	}

	// ----------------------------------------------------------------- results

	public record SavedAnalysis(long analysisId, String title, Instant savedAt, int buildingCount) {
	}

	/** @param buildingCount buildings in the result (INSIDE + PARTIAL) */
	public record HistoryItem(long analysisId, String title, int radiusMeters, Center center, int buildingCount,
			boolean complete, Instant analyzedAt, Instant savedAt) {
	}

	public record HistoryPage(List<HistoryItem> items, int page, int size, long totalItems, int totalPages,
			int maxHistory) {
	}

	/** @param result the saved analysis in the same structure as GET /api/buildings/nearby */
	public record AnalysisDetail(long analysisId, String title, Instant analyzedAt, Instant savedAt,
			RadiusAnalysisResult result) {
	}

}
