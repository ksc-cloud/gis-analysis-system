package com.example.gis_analysis_system.analysis;

import java.util.List;

import com.example.gis_analysis_system.vworld.BuildingInfo;

/**
 * Result of a radius analysis: LT_C_SPBD buildings whose footprint intersects the circle.
 *
 * @param center analysis center (WGS84)
 * @param radiusMeters circle radius in meters
 * @param criterion how buildings are included
 * @param criterionDescription the criterion in words
 * @param distanceDescription what {@link AnalyzedBuilding#distanceMeters()} means
 * @param complete {@code true} only when every feature VWorld reported was collected and judged
 * @param incompleteReasons why the result may be missing buildings (empty when complete)
 * @param reportedTotal record.total reported by VWorld for the buffer query, or {@code null} when unknown
 * @param fetchedFeatures features actually received (before merging duplicates)
 * @param fetchedPages pages actually received
 * @param reportedPages page.total reported by VWorld, or {@code null} when unknown
 * @param summary counts
 * @param floorStatistics ground floor statistics of the included buildings
 * @param buildings included buildings (INSIDE and PARTIAL), nearest first
 * @param source data source
 */
public record RadiusAnalysisResult(Center center, int radiusMeters, String criterion, String criterionDescription,
		String distanceDescription, boolean complete, List<IncompleteReason> incompleteReasons, Integer reportedTotal,
		int fetchedFeatures, int fetchedPages, Integer reportedPages, Summary summary, FloorStatistics floorStatistics,
		List<AnalyzedBuilding> buildings, DataSource source) {

	public static final String CRITERION = "POLYGON_INTERSECTS_CIRCLE";

	/** How a footprint relates to the circle (closed disk: touching the circle counts as intersecting). */
	public enum Relation {

		/** The whole footprint lies within the circle. */
		INSIDE,

		/** Part of the footprint lies within the circle, or it touches the circle. */
		PARTIAL,

		/** The footprint does not reach the circle. */
		OUTSIDE

	}

	public record Center(double lon, double lat) {
	}

	public enum ReasonCode {

		/** More pages than the per-analysis page limit. */
		PAGE_LIMIT,

		/** The time budget for one analysis ran out before all pages were fetched. */
		TIME_LIMIT,

		/** A later page failed with a VWorld or network error. */
		EXTERNAL_API_ERROR,

		/** A later page timed out. */
		EXTERNAL_API_TIMEOUT,

		/** VWorld answered a different page than requested. */
		PAGINATION_INCONSISTENT,

		/** record.total changed between pages. */
		TOTAL_CHANGED,

		/** Fewer features were received than VWorld reported. */
		COUNT_MISMATCH,

		/** VWorld did not report record.total, so completeness cannot be confirmed. */
		TOTAL_UNKNOWN,

		/** Some buildings had no readable geometry and could not be judged. */
		GEOMETRY_UNAVAILABLE

	}

	public record IncompleteReason(ReasonCode code, String message) {
	}

	/**
	 * @param intersecting included buildings (inside + partial)
	 * @param inside footprint entirely within the circle
	 * @param partial footprint crosses or touches the circle
	 * @param outsideExcluded returned by VWorld but not reaching the circle in the server-side check
	 * @param geometryUnavailable buildings that could not be judged
	 * @param distinctBuildings buildings after merging duplicate features
	 * @param mergedDuplicateFeatures features merged into another feature with the same identity
	 */
	public record Summary(int intersecting, int inside, int partial, int outsideExcluded, int geometryUnavailable,
			int distinctBuildings, int mergedDuplicateFeatures) {
	}

	/**
	 * Only gro_flo_co values that are whole numbers of at least 1 are used; 0 and other values are "정보 없음".
	 */
	public record FloorStatistics(int withData, int withoutData, Integer min, Integer max, Double average,
			List<FloorBucket> distribution) {
	}

	/** @param max upper bound (inclusive), or {@code null} for open-ended */
	public record FloorBucket(String label, int min, Integer max, int count) {
	}

	/**
	 * @param id identity used for merging: {@code bd:<bd_mgt_sn>}, otherwise {@code feature:<feature id>},
	 * otherwise {@code row:<index>} (never merged). Not related to the 3D model TD_ID
	 * @param building attributes
	 * @param relation INSIDE or PARTIAL
	 * @param distanceMeters shortest horizontal distance from the center to the footprint (0 when the center is
	 * inside the footprint; a center inside a hole is outside the building)
	 * @param centerInside whether the center lies inside the footprint
	 * @param hasHoles whether any footprint polygon has inner rings
	 * @param polygons footprint polygons {@code rings[points[lon, lat]]}, rounded to 7 decimals (about 1 cm)
	 */
	public record AnalyzedBuilding(String id, BuildingInfo building, Relation relation, double distanceMeters,
			boolean centerInside, boolean hasHoles, List<double[][][]> polygons) {
	}

	public record DataSource(String provider, String layer, String coordinateSystem, String notice) {
	}

}
