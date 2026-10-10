package com.example.gis_analysis_system.vworld;

/**
 * Failure while calling a VWorld API. Messages never contain the request URL, because it includes the API key.
 */
public class VWorldApiException extends RuntimeException {

	public enum Reason {

		/** vworld.api-key is not configured. */
		API_KEY_MISSING,

		/** VWorld answered with status ERROR or an HTTP error. */
		API_ERROR,

		/** The connection or the response timed out. */
		TIMEOUT,

		/** VWorld could not be reached. */
		NETWORK_ERROR,

		/** The response did not have the expected structure. */
		UNEXPECTED_RESPONSE

	}

	private final Reason reason;

	private final String vworldErrorCode;

	public VWorldApiException(Reason reason, String vworldErrorCode, String message) {
		super(message);
		this.reason = reason;
		this.vworldErrorCode = vworldErrorCode;
	}

	public Reason getReason() {
		return this.reason;
	}

	/**
	 * Error code returned by VWorld (for example {@code INVALID_KEY}), or {@code null}.
	 */
	public String getVworldErrorCode() {
		return this.vworldErrorCode;
	}

}
