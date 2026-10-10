package com.example.gis_analysis_system.vworld;

import java.util.List;

/**
 * Result of looking up LT_C_SPBD buildings that contain a point.
 *
 * @param status whether exactly one building matched
 * @param totalCount total number of features reported by VWorld
 * @param buildings the matched buildings (candidates when {@link Status#AMBIGUOUS})
 */
public record BuildingLookupResult(Status status, int totalCount, List<BuildingInfo> buildings) {

	public enum Status {

		/** Exactly one building contains the point. */
		FOUND,

		/** No building contains the point. */
		NOT_FOUND,

		/** More than one building matched, so none is chosen. */
		AMBIGUOUS

	}

	public static BuildingLookupResult notFound() {
		return new BuildingLookupResult(Status.NOT_FOUND, 0, List.of());
	}

}
