package com.example.gis_analysis_system.history;

import java.time.LocalDateTime;

/**
 * One row of gis_analysis_history. Times are UTC.
 *
 * @param analysisId generated key, {@code null} before the row is inserted
 */
public record HistoryRow(Long analysisId, String snapshotToken, String title, double centerLon, double centerLat,
		int radiusM, String criterion, int intersectingCount, int insideCount, int partialCount,
		int outsideExcludedCount, int geometryUnavailableCount, int distinctBuildingCount, int mergedDuplicateCount,
		Integer reportedTotal, int fetchedFeatures, int fetchedPages, Integer reportedPages, boolean complete,
		String sourceProvider, String sourceLayer, String sourceCrs, String sourceNotice, LocalDateTime analyzedAt,
		LocalDateTime savedAt) {

}
