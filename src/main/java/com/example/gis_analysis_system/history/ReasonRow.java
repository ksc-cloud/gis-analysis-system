package com.example.gis_analysis_system.history;

/** One row of gis_analysis_incomplete_reason. */
public record ReasonRow(long analysisId, int seq, String reasonCode, String message) {

}
