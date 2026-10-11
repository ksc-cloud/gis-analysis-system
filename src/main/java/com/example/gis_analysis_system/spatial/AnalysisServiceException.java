package com.example.gis_analysis_system.spatial;

/**
 * A failure of the Python analysis service, already translated for the browser. Messages never contain the token,
 * the request geometry or Python's own error text.
 */
public class AnalysisServiceException extends RuntimeException {

	public enum Reason {

		/** The token or the base URL is not configured (or the URL is not loopback). Python was not called. */
		ANALYSIS_SERVICE_NOT_CONFIGURED(503),

		/** Python is not running, refused or did not accept the connection in time, or answered 503. */
		ANALYSIS_SERVICE_UNAVAILABLE(503),

		/** Python accepted the request but did not answer in time. */
		ANALYSIS_SERVICE_TIMEOUT(504),

		/** Python rejected the internal token (401). */
		ANALYSIS_SERVICE_AUTH_FAILED(502),

		/** The request is larger than the configured limit (checked before sending) or Python answered 413. */
		ANALYSIS_TOO_LARGE(413),

		/** Python could not accept the analysis data (422). */
		ANALYSIS_DATA_UNSUPPORTED(422),

		/** Python failed (500) or answered an unexpected status. */
		ANALYSIS_SERVICE_ERROR(502),

		/** Python answered 200 with a body that is not the documented JSON. */
		ANALYSIS_SERVICE_BAD_RESPONSE(502),

		/** The concurrent request limit is reached. */
		ANALYSIS_SERVICE_BUSY(503);

		private final int status;

		Reason(int status) {
			this.status = status;
		}

		public int status() {
			return this.status;
		}

	}

	private final Reason reason;

	private final String serviceError;

	public AnalysisServiceException(Reason reason, String message) {
		this(reason, message, null);
	}

	/**
	 * @param serviceError Python's {@code error} code (for example {@code VALIDATION_ERROR}), only when it is a plain
	 * upper-case code
	 */
	public AnalysisServiceException(Reason reason, String message, String serviceError) {
		super(message);
		this.reason = reason;
		this.serviceError = (serviceError != null && serviceError.matches("[A-Z][A-Z_]{0,59}")) ? serviceError : null;
	}

	public Reason getReason() {
		return this.reason;
	}

	public String getServiceError() {
		return this.serviceError;
	}

}
