package com.example.gis_analysis_system.history;

/** A request the analysis history cannot fulfil, with a code the API turns into a status and an error name. */
public class AnalysisHistoryException extends RuntimeException {

	public enum Code {

		/** The analysis token is missing or not a UUID. */
		INVALID_TOKEN,

		/** The title is empty, too long or contains control characters. */
		INVALID_TITLE,

		/** page or size is out of range. */
		INVALID_PAGE,

		/** The sort value is not one of the allowed orders. */
		INVALID_SORT,

		/** The analysis id is not a positive whole number. */
		INVALID_ID,

		/** No saved analysis has this id. */
		ANALYSIS_NOT_FOUND,

		/** The result behind this token was saved before. */
		ALREADY_SAVED,

		/** The history already holds the maximum number of analyses. */
		HISTORY_LIMIT,

		/** The token is unknown or expired (also after a server restart). */
		SNAPSHOT_EXPIRED,

		/** The result has a value the history tables cannot hold. */
		UNSUPPORTED_RESULT,

		/** A saved analysis could not be read back (stored data does not have the expected form). */
		STORED_DATA_INVALID

	}

	private final Code code;

	private final Long analysisId;

	public AnalysisHistoryException(Code code, String message) {
		this(code, message, null);
	}

	public AnalysisHistoryException(Code code, String message, Long analysisId) {
		super(message);
		this.code = code;
		this.analysisId = analysisId;
	}

	public Code getCode() {
		return this.code;
	}

	/** The related saved analysis (for {@link Code#ALREADY_SAVED}), otherwise {@code null}. */
	public Long getAnalysisId() {
		return this.analysisId;
	}

}
