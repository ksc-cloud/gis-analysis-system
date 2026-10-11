package com.example.gis_analysis_system.spatial;

import java.util.Map;
import java.util.Set;

import tools.jackson.databind.JsonNode;

/**
 * Checks that a 200 response of the Python service has the documented structure before it is passed to the browser:
 * schemaVersion 1, the required top-level fields of each endpoint with their JSON types, and the basic shape of the
 * main nested objects. Anything else is {@link InvalidResponseException} (ANALYSIS_SERVICE_BAD_RESPONSE).
 * <p>
 * The schemas are analysis-service/app/schemas/{building_stats,grid_density,compare,hotspot}.py.
 */
final class PythonResponseValidator {

	static final int SCHEMA_VERSION = 1;

	private static final Set<String> COMPARISON_BASES = Set.of("CHANGE", "OBSERVATION_DIFFERENCE");

	private static final Set<String> SCOPES = Set.of("COMPLETE_RESULT", "OBSERVED_BUILDINGS_ONLY");

	private static final String BLOCKED = "PARTIAL_RESULT_BLOCKED";

	private static final Set<String> HOTSPOT_STATUSES = Set.of("OK", "CONSTANT_VALUES", "INSUFFICIENT_CELLS", BLOCKED);

	private static final String NOT_TESTED = "NOT_TESTED";

	/** bin of every tested hotspotClass (NOT_TESTED has no bin). */
	private static final Map<String, Integer> HOTSPOT_BINS = Map.of("HOT_99", 3, "HOT_95", 2, "HOT_90", 1,
			"NOT_SIGNIFICANT", 0, "COLD_90", -1, "COLD_95", -2, "COLD_99", -3);

	private PythonResponseValidator() {
	}

	static final class InvalidResponseException extends RuntimeException {

		InvalidResponseException(String message) {
			super(message);
		}

	}

	static void buildingStats(JsonNode root) {
		common(root);
		requireInt(root, "radiusMeters");
		requireObject(root, "method");
		counts(requireObject(root, "counts"));
		JsonNode footprint = requireObject(root, "footprint");
		requireNumber(footprint, "sumArea");
		requireNumber(footprint, "unionArea");
		JsonNode within = requireObject(root, "withinRadius");
		requireNumber(within, "unionArea");
		requireNumber(within, "coverageRatio");
		JsonNode floors = requireObject(root, "floors");
		requireInt(floors, "withData");
		requireInt(floors, "withoutData");
		completeness(requireObject(root, "completeness"));
		requireArray(root, "warnings");
		requireArray(root, "excluded");
		JsonNode buildings = require(root, "buildings");
		if (!buildings.isNull()) {
			requireArrayValue(buildings, "buildings");
		}
	}

	static void gridDensity(JsonNode root) {
		common(root);
		requireInt(root, "radiusMeters");
		requireInt(root, "cellSizeMeters");
		requireObject(root, "method");
		JsonNode grid = requireObject(root, "grid");
		requireInt(grid, "cellCount");
		requireInt(grid, "returnedCellCount");
		counts(requireObject(root, "counts"));
		JsonNode summary = requireObject(root, "summary");
		requireNumber(summary, "occupiedArea");
		requireNumber(summary, "coverageRatio");
		JsonNode consistency = requireObject(root, "consistency");
		requireBoolean(consistency, "occupiedAreaMatches");
		requireBoolean(consistency, "primaryMatchesAnalyzed");
		completeness(requireObject(root, "completeness"));
		requireArray(root, "warnings");
		requireArray(root, "excluded");
		JsonNode cells = requireObject(root, "cells");
		requireText(cells, "type", "FeatureCollection");
		JsonNode features = requireArray(cells, "features");
		if (features.size() != grid.get("returnedCellCount").asInt()) {
			throw invalid("cells.features does not match grid.returnedCellCount");
		}
		for (JsonNode feature : features) {
			if (!feature.isObject()) {
				throw invalid("cells.features[] is not an object");
			}
			requireText(feature, "type", "Feature");
			requireText(feature, "id", null);
			requireText(requireObject(feature, "geometry"), "type", "Polygon");
			requireArray(feature.get("geometry"), "coordinates");
			JsonNode properties = requireObject(feature, "properties");
			requireInt(properties, "buildingCount");
			requireNumber(properties, "coverageRatio");
		}
	}

	static void compare(JsonNode root) {
		common(root);
		boolean comparable = requireBoolean(root, "comparable");
		String basis = requireText(root, "comparisonBasis", null);
		if (!COMPARISON_BASES.contains(basis)) {
			throw invalid("comparisonBasis has an unknown value");
		}
		requireArray(root, "notComparableReasons");
		for (String side : new String[] { "before", "after" }) {
			JsonNode analysis = requireObject(root, side);
			requireObject(analysis, "source");
			counts(requireObject(analysis, "counts"));
		}
		requireObject(root, "conditions");
		requireObject(root, "method");
		JsonNode statistics = require(root, "statistics");
		JsonNode buildings = require(root, "buildings");
		if (comparable) {
			requireObjectValue(statistics, "statistics");
			requireObject(statistics, "buildingCount");
			requireObject(statistics, "unionArea");
			requireObject(statistics, "coverageRatio");
			requireObjectValue(buildings, "buildings");
			requireObject(buildings, "summary");
		}
		else if (!statistics.isNull() || !buildings.isNull()) {
			throw invalid("statistics and buildings must be null when comparable is false");
		}
		requireArray(root, "warnings");
		requireArray(root, "notes");
	}

	/**
	 * analysis-service/app/schemas/hotspot.py (HotspotResponse) and the invariants app/services/hotspot.py keeps:
	 * <ul>
	 * <li>PARTIAL_RESULT_BLOCKED: at least one blocked reason, completeness.complete false, grid/counts/moran null, no
	 * cells, summary 0. Blocked before the grid (Java partial result): sourceComplete false and pythonGeometryExcluded
	 * null; blocked by an unrepairable building: sourceComplete true and pythonGeometryExcluded at least 1.</li>
	 * <li>Otherwise: no blocked reason, complete and sourceComplete true, pythonGeometryExcluded 0, grid and counts,
	 * one feature per grid cell; moran only for OK (zSimulated may be null), every cell NOT_TESTED for
	 * CONSTANT_VALUES and INSUFFICIENT_CELLS.</li>
	 * <li>Cells: class and bin match, HOT has z &gt; 0 and COLD z &lt; 0, a tested cell has z and p, q in [0, 1] and no
	 * reason, a NOT_TESTED cell has null statistics and a reason.</li>
	 * </ul>
	 */
	static void hotspot(JsonNode root) {
		common(root);
		requireInt(root, "radiusMeters");
		requireInt(root, "cellSizeMeters");
		String status = requireText(root, "status", null);
		if (!HOTSPOT_STATUSES.contains(status)) {
			throw invalid("status has an unknown value");
		}
		JsonNode blockedReasons = requireArray(root, "blockedReasons");
		for (JsonNode reason : blockedReasons) {
			if (!reason.isString()) {
				throw invalid("blockedReasons[] is not a string");
			}
		}
		requireObject(root, "method");
		JsonNode summary = requireObject(root, "summary");
		int cellCount = requireCount(summary, "cellCount");
		int studyCellCount = requireCount(summary, "studyCellCount");
		int testedCellCount = requireCount(summary, "testedCellCount");
		if (testedCellCount > studyCellCount || studyCellCount > cellCount) {
			throw invalid("summary counts are not testedCellCount <= studyCellCount <= cellCount");
		}
		long classified = 0;
		JsonNode classes = requireObject(summary, "classes");
		for (String hotspotClass : classes.propertyNames()) {
			classified += requireCount(classes, hotspotClass);
		}
		if (classified != cellCount) {
			throw invalid("summary.classes does not add up to summary.cellCount");
		}
		JsonNode completeness = requireObject(root, "completeness");
		completeness(completeness);
		boolean complete = completeness.get("complete").asBoolean();
		boolean sourceComplete = requireBoolean(completeness, "sourceComplete");
		JsonNode pythonGeometryExcluded = require(completeness, "pythonGeometryExcluded");
		requireArray(root, "warnings");
		JsonNode cells = requireObject(root, "cells");
		requireText(cells, "type", "FeatureCollection");
		JsonNode features = requireArray(cells, "features");
		JsonNode grid = require(root, "grid");
		JsonNode counts = require(root, "counts");
		JsonNode moran = require(root, "moran");

		if (BLOCKED.equals(status)) {
			if (blockedReasons.isEmpty() || complete) {
				throw invalid("a blocked result needs blockedReasons and completeness.complete false");
			}
			if (!grid.isNull() || !counts.isNull() || !moran.isNull() || !features.isEmpty() || cellCount != 0) {
				throw invalid("a blocked result has no grid, counts, moran or cells");
			}
			boolean expected = sourceComplete
					? pythonGeometryExcluded.isIntegralNumber() && pythonGeometryExcluded.asLong() >= 1
					: pythonGeometryExcluded.isNull();
			if (!expected) {
				throw invalid("completeness.pythonGeometryExcluded does not match the blocking");
			}
			return;
		}
		if (!blockedReasons.isEmpty() || !complete || !sourceComplete) {
			throw invalid("an analyzed result has no blockedReasons and complete input");
		}
		if (!pythonGeometryExcluded.isIntegralNumber() || pythonGeometryExcluded.asLong() != 0) {
			throw invalid("completeness.pythonGeometryExcluded is not 0");
		}
		int gridCellCount = requireCount(requireObjectValue(grid, "grid"), "cellCount");
		counts(requireObjectValue(counts, "counts"));
		if (features.size() != gridCellCount || gridCellCount != cellCount) {
			throw invalid("cells.features does not match grid.cellCount and summary.cellCount");
		}
		boolean ok = "OK".equals(status);
		if (ok) {
			JsonNode result = requireObjectValue(moran, "moran");
			requireFinite(result, "i");
			requireFinite(result, "expected");
			requireFinite(result, "simulatedMean");
			if (requireFinite(result, "simulatedSd") < 0) {
				throw invalid("moran.simulatedSd is negative");
			}
			if (!require(result, "zSimulated").isNull()) {
				requireFinite(result, "zSimulated");
			}
			double p = requireFinite(result, "pValue");
			if (p <= 0 || p > 1) {
				throw invalid("moran.pValue is not in (0, 1]");
			}
		}
		else if (!moran.isNull()) {
			throw invalid("moran must be null unless the status is OK");
		}
		int tested = 0;
		for (JsonNode feature : features) {
			if (!feature.isObject()) {
				throw invalid("cells.features[] is not an object");
			}
			requireText(feature, "type", "Feature");
			requireText(feature, "id", null);
			requireText(requireObject(feature, "geometry"), "type", "Polygon");
			requireArray(feature.get("geometry"), "coordinates");
			if (hotspotCell(requireObject(feature, "properties"))) {
				tested++;
			}
		}
		if (tested != testedCellCount || (!ok && tested != 0)) {
			throw invalid("tested cells do not match the status and summary.testedCellCount");
		}
	}

	/** @return whether the cell was tested (has a Gi* result) */
	private static boolean hotspotCell(JsonNode properties) {
		requireInt(properties, "col");
		requireInt(properties, "row");
		requireFinite(properties, "coverageRatio");
		JsonNode neighborCount = require(properties, "neighborCount");
		if (!neighborCount.isNull()) {
			requireCount(properties, "neighborCount");
		}
		String hotspotClass = requireText(properties, "hotspotClass", null);
		JsonNode bin = require(properties, "bin");
		JsonNode giZ = require(properties, "giZ");
		JsonNode pValue = require(properties, "pValue");
		JsonNode qValue = require(properties, "qValue");
		JsonNode reason = require(properties, "reason");
		if (NOT_TESTED.equals(hotspotClass)) {
			if (!bin.isNull() || !giZ.isNull() || !pValue.isNull() || !qValue.isNull() || !reason.isString()) {
				throw invalid("a NOT_TESTED cell has null statistics and a reason");
			}
			return false;
		}
		Integer expectedBin = HOTSPOT_BINS.get(hotspotClass);
		if (expectedBin == null) {
			throw invalid("hotspotClass has an unknown value");
		}
		if (!bin.isIntegralNumber() || bin.asInt() != expectedBin || !reason.isNull()) {
			throw invalid("bin or reason does not match hotspotClass");
		}
		double z = requireFinite(properties, "giZ");
		if ((expectedBin > 0 && z <= 0) || (expectedBin < 0 && z >= 0)) {
			throw invalid("giZ does not have the sign of hotspotClass");
		}
		for (String field : new String[] { "pValue", "qValue" }) {
			double value = requireFinite(properties, field);
			if (value < 0 || value > 1) {
				throw invalid(field + " is not in [0, 1]");
			}
		}
		return true;
	}

	private static void common(JsonNode root) {
		if (root == null || !root.isObject()) {
			throw invalid("the response is not a JSON object");
		}
		JsonNode version = root.get("schemaVersion");
		if (version == null || !version.isIntegralNumber() || version.asInt() != SCHEMA_VERSION) {
			throw invalid("schemaVersion is not " + SCHEMA_VERSION);
		}
	}

	private static void counts(JsonNode counts) {
		requireInt(counts, "total");
		requireInt(counts, "analyzed");
		requireInt(counts, "excluded");
	}

	private static void completeness(JsonNode completeness) {
		requireBoolean(completeness, "complete");
		if (!SCOPES.contains(requireText(completeness, "scope", null))) {
			throw invalid("completeness.scope has an unknown value");
		}
		requireArray(completeness, "notes");
	}

	private static JsonNode require(JsonNode parent, String field) {
		JsonNode value = parent.get(field);
		if (value == null) {
			throw invalid("missing field " + field);
		}
		return value;
	}

	private static JsonNode requireObject(JsonNode parent, String field) {
		return requireObjectValue(require(parent, field), field);
	}

	private static JsonNode requireObjectValue(JsonNode value, String field) {
		if (!value.isObject()) {
			throw invalid(field + " is not an object");
		}
		return value;
	}

	private static JsonNode requireArray(JsonNode parent, String field) {
		return requireArrayValue(require(parent, field), field);
	}

	private static JsonNode requireArrayValue(JsonNode value, String field) {
		if (!value.isArray()) {
			throw invalid(field + " is not an array");
		}
		return value;
	}

	private static void requireInt(JsonNode parent, String field) {
		if (!require(parent, field).isIntegralNumber()) {
			throw invalid(field + " is not an integer");
		}
	}

	/** A non-negative integer that fits an int. */
	private static int requireCount(JsonNode parent, String field) {
		JsonNode value = require(parent, field);
		if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < 0) {
			throw invalid(field + " is not a non-negative integer");
		}
		return value.asInt();
	}

	/** A finite number (JSON has no NaN, but a huge exponent reads as infinity). */
	private static double requireFinite(JsonNode parent, String field) {
		JsonNode value = require(parent, field);
		if (!value.isNumber() || !Double.isFinite(value.asDouble())) {
			throw invalid(field + " is not a finite number");
		}
		return value.asDouble();
	}

	private static void requireNumber(JsonNode parent, String field) {
		if (!require(parent, field).isNumber()) {
			throw invalid(field + " is not a number");
		}
	}

	private static boolean requireBoolean(JsonNode parent, String field) {
		JsonNode value = require(parent, field);
		if (!value.isBoolean()) {
			throw invalid(field + " is not a boolean");
		}
		return value.asBoolean();
	}

	/** @param expected required value, or {@code null} for any string */
	private static String requireText(JsonNode parent, String field, String expected) {
		JsonNode value = require(parent, field);
		if (!value.isString() || (expected != null && !expected.equals(value.asString()))) {
			throw invalid(field + " is not " + ((expected != null) ? "\"" + expected + "\"" : "a string"));
		}
		return value.asString();
	}

	private static InvalidResponseException invalid(String message) {
		return new InvalidResponseException(message);
	}

}
