package com.example.gis_analysis_system.spatial;

/** A request the spatial analysis API rejects before calling Python (400). */
public class InvalidSpatialRequestException extends RuntimeException {

	private final String error;

	public InvalidSpatialRequestException(String error, String message) {
		super(message);
		this.error = error;
	}

	public String getError() {
		return this.error;
	}

}
