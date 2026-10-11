package com.example.gis_analysis_system.history;

import java.time.LocalDateTime;

/** One line of the history list. Times are UTC. */
public record HistorySummaryRow(long analysisId, String title, int radiusM, double centerLon, double centerLat,
		int intersectingCount, boolean complete, LocalDateTime analyzedAt, LocalDateTime savedAt) {

}
