package com.example.gis_analysis_system.spatial;

import java.util.List;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Summary;

/**
 * Request bodies of the Python internal API (analysis-service/app/schemas). Field names are the JSON names; Python
 * rejects unknown fields, so these records carry exactly the documented fields.
 */
final class PythonRequests {

	static final int SCHEMA_VERSION = 1;

	private PythonRequests() {
	}

	/** @param kind SAVED (analysisId set) or LIVE; analyzedAt is ISO-8601 with a time zone ({@code ...Z}) */
	record Source(String kind, Long analysisId, String analyzedAt) {
	}

	record Center(double lon, double lat) {
	}

	record IncompleteReason(String code, String message) {
	}

	/** Always a MultiPolygon: {@code coordinates[polygon][ring][point] = [lon, lat]}. */
	record Geometry(String type, List<double[][][]> coordinates) {
	}

	record Building(String id, String groundFloorRaw, String relation, double distanceMeters, Geometry geometry) {
	}

	record DataSource(String provider, String layer, String coordinateSystem, String notice) {
	}

	/** POST /internal/v1/building-stats */
	record BuildingStats(int schemaVersion, Source source, Center center, int radiusMeters, boolean complete,
			List<IncompleteReason> incompleteReasons, Summary javaSummary, boolean includeBuildings,
			List<Building> buildings) {
	}

	/** POST /internal/v1/grid-density */
	record GridDensity(int schemaVersion, Source source, Center center, int radiusMeters, boolean complete,
			List<IncompleteReason> incompleteReasons, Summary javaSummary, List<Building> buildings,
			int cellSizeMeters, boolean includeEmptyCells, boolean includeCellBuildingIds) {
	}

	/**
	 * POST /internal/v1/hotspot. permutations and seed are not sent: Python uses its defaults (999, 20261012).
	 * A partial analysis is sent as it is; Python decides whether it is blocked.
	 */
	record Hotspot(int schemaVersion, Source source, Center center, int radiusMeters, boolean complete,
			List<IncompleteReason> incompleteReasons, Summary javaSummary, List<Building> buildings,
			int cellSizeMeters) {
	}

	/** One side of POST /internal/v1/compare-analyses. */
	record SavedAnalysis(int schemaVersion, Source source, Center center, int radiusMeters, boolean complete,
			List<IncompleteReason> incompleteReasons, Summary javaSummary, List<Building> buildings, String criterion,
			DataSource dataSource) {
	}

	/** POST /internal/v1/compare-analyses */
	record Compare(int schemaVersion, SavedAnalysis before, SavedAnalysis after, boolean includeUnchanged,
			boolean includeBuildingChanges) {
	}

}
