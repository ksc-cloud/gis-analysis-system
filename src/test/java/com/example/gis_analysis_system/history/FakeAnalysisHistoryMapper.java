package com.example.gis_analysis_system.history;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.dao.DuplicateKeyException;

/**
 * In-memory stand-in for the MariaDB tables used by service unit tests: it enforces the unique snapshot token,
 * cascades deletes and can undo the changes of a rolled back transaction (see {@link RecordingTransactionManager}).
 * Real SQL is covered by the MariaDB integration tests.
 */
class FakeAnalysisHistoryMapper implements AnalysisHistoryMapper {

	final Map<Long, HistoryRow> history = new LinkedHashMap<>();

	final List<ReasonRow> reasons = new ArrayList<>();

	final List<BuildingRow> buildings = new ArrayList<>();

	final List<Integer> buildingBatchSizes = new ArrayList<>();

	final AtomicInteger insertHistoryCalls = new AtomicInteger();

	/** Extra rows counted by countHistory (to test the limit without inserting 500 analyses). */
	long existingRows;

	/** Fails the n-th insertBuildings call (1-based); 0 = never. */
	int failOnBuildingBatch;

	/** Throws DuplicateKeyException from insertHistory once, as another application instance would cause. */
	Long simulateOtherInstanceSaved;

	private long nextId = 1;

	private Snapshot transactionStart;

	/** A row committed by "another instance": it survives the rollback of our own transaction. */
	private HistoryRow committedElsewhere;

	synchronized void begin() {
		this.transactionStart = new Snapshot(new LinkedHashMap<>(this.history), new ArrayList<>(this.reasons),
				new ArrayList<>(this.buildings), this.nextId);
	}

	synchronized void commit() {
		this.transactionStart = null;
	}

	synchronized void rollback() {
		if (this.transactionStart != null) {
			this.history.clear();
			this.history.putAll(this.transactionStart.history);
			this.reasons.clear();
			this.reasons.addAll(this.transactionStart.reasons);
			this.buildings.clear();
			this.buildings.addAll(this.transactionStart.buildings);
			this.transactionStart = null;
		}
		if (this.committedElsewhere != null) {
			this.history.put(this.committedElsewhere.analysisId(), this.committedElsewhere);
			this.committedElsewhere = null;
		}
	}

	@Override
	public synchronized Long findIdByToken(String snapshotToken) {
		return this.history.values()
			.stream()
			.filter((row) -> row.snapshotToken().equals(snapshotToken))
			.map(HistoryRow::analysisId)
			.findFirst()
			.orElse(null);
	}

	@Override
	public synchronized long countHistory() {
		return this.existingRows + this.history.size();
	}

	@Override
	public synchronized void insertHistory(HistoryInsert insert) {
		this.insertHistoryCalls.incrementAndGet();
		HistoryRow row = insert.getRow();
		if (this.simulateOtherInstanceSaved != null) {
			this.committedElsewhere = withId(row, this.simulateOtherInstanceSaved);
			this.simulateOtherInstanceSaved = null;
			throw new DuplicateKeyException("uk_history_snapshot_token");
		}
		if (findIdByToken(row.snapshotToken()) != null) {
			throw new DuplicateKeyException("uk_history_snapshot_token");
		}
		long id = this.nextId++;
		this.history.put(id, withId(row, id));
		insert.setAnalysisId(id);
	}

	@Override
	public synchronized void insertReasons(List<ReasonRow> rows) {
		this.reasons.addAll(rows);
	}

	@Override
	public synchronized void insertBuildings(List<BuildingRow> rows) {
		this.buildingBatchSizes.add(rows.size());
		if (this.failOnBuildingBatch == this.buildingBatchSizes.size()) {
			throw new org.springframework.dao.DataIntegrityViolationException("simulated failure");
		}
		this.buildings.addAll(rows);
	}

	@Override
	public synchronized List<HistorySummaryRow> findPage(HistorySort sort, int limit, long offset) {
		Comparator<HistoryRow> order = switch (sort) {
			case SAVED_ASC -> Comparator.comparing(HistoryRow::savedAt).thenComparing(HistoryRow::analysisId);
			case TITLE_ASC -> Comparator.comparing(HistoryRow::title)
				.thenComparing(HistoryRow::analysisId, Comparator.reverseOrder());
			case BUILDINGS_DESC -> Comparator.comparing(HistoryRow::intersectingCount, Comparator.reverseOrder())
				.thenComparing(HistoryRow::savedAt, Comparator.reverseOrder())
				.thenComparing(HistoryRow::analysisId, Comparator.reverseOrder());
			case SAVED_DESC -> Comparator.comparing(HistoryRow::savedAt, Comparator.reverseOrder())
				.thenComparing(HistoryRow::analysisId, Comparator.reverseOrder());
		};
		return this.history.values()
			.stream()
			.sorted(order)
			.skip(offset)
			.limit(limit)
			.map((row) -> new HistorySummaryRow(row.analysisId(), row.title(), row.radiusM(), row.centerLon(),
					row.centerLat(), row.intersectingCount(), row.complete(), row.analyzedAt(), row.savedAt()))
			.toList();
	}

	@Override
	public synchronized HistoryRow findHistory(long analysisId) {
		return this.history.get(analysisId);
	}

	@Override
	public synchronized List<ReasonRow> findReasons(long analysisId) {
		return this.reasons.stream()
			.filter((row) -> row.analysisId() == analysisId)
			.sorted(Comparator.comparingInt(ReasonRow::seq))
			.toList();
	}

	@Override
	public synchronized List<BuildingRow> findBuildings(long analysisId) {
		return this.buildings.stream()
			.filter((row) -> row.analysisId() == analysisId)
			.sorted(Comparator.comparingInt(BuildingRow::seq))
			.toList();
	}

	@Override
	public synchronized FloorStatsRow findFloorStats(long analysisId) {
		List<Integer> floors = findBuildings(analysisId).stream()
			.map(BuildingRow::groundFloorCount)
			.filter(Objects::nonNull)
			.toList();
		int total = findBuildings(analysisId).size();
		return new FloorStatsRow(floors.size(), total - floors.size(),
				floors.stream().min(Integer::compare).orElse(null), floors.stream().max(Integer::compare).orElse(null),
				floors.stream().mapToLong(Integer::longValue).sum(), count(floors, 1, 2), count(floors, 3, 5),
				count(floors, 6, 10), count(floors, 11, 20), count(floors, 21, Integer.MAX_VALUE));
	}

	@Override
	public synchronized int deleteHistory(long analysisId) {
		if (this.history.remove(analysisId) == null) {
			return 0;
		}
		this.reasons.removeIf((row) -> row.analysisId() == analysisId);
		this.buildings.removeIf((row) -> row.analysisId() == analysisId);
		return 1;
	}

	private static int count(List<Integer> floors, int min, int max) {
		return (int) floors.stream().filter((f) -> f >= min && f <= max).count();
	}

	private static HistoryRow withId(HistoryRow row, long id) {
		return new HistoryRow(id, row.snapshotToken(), row.title(), row.centerLon(), row.centerLat(), row.radiusM(),
				row.criterion(), row.intersectingCount(), row.insideCount(), row.partialCount(),
				row.outsideExcludedCount(), row.geometryUnavailableCount(), row.distinctBuildingCount(),
				row.mergedDuplicateCount(), row.reportedTotal(), row.fetchedFeatures(), row.fetchedPages(),
				row.reportedPages(), row.complete(), row.sourceProvider(), row.sourceLayer(), row.sourceCrs(),
				row.sourceNotice(), row.analyzedAt(), row.savedAt());
	}

	private record Snapshot(Map<Long, HistoryRow> history, List<ReasonRow> reasons, List<BuildingRow> buildings,
			long nextId) {
	}

}
