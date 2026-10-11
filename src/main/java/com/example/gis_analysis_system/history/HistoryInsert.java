package com.example.gis_analysis_system.history;

/** Parameter of the history insert; MyBatis writes the generated key back into {@link #setAnalysisId(Long)}. */
public final class HistoryInsert {

	private final HistoryRow row;

	private Long analysisId;

	HistoryInsert(HistoryRow row) {
		this.row = row;
	}

	public HistoryRow getRow() {
		return this.row;
	}

	public Long getAnalysisId() {
		return this.analysisId;
	}

	public void setAnalysisId(Long analysisId) {
		this.analysisId = analysisId;
	}

}
