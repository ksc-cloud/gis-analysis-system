package com.example.gis_analysis_system.spatial;

import java.util.Set;

import tools.jackson.databind.JsonNode;

/**
 * Checks that a 200 response of the Python service has the documented structure before it is passed to the browser:
 * schemaVersion 1, the required top-level fields of each endpoint with their JSON types, and the basic shape of the
 * main nested objects. Anything else is {@link InvalidResponseException} (ANALYSIS_SERVICE_BAD_RESPONSE).
 * <p>
 * The schemas are analysis-service/app/schemas/{building_stats,grid_density,compare}.py.
 */
final class PythonResponseValidator {

	static final int SCHEMA_VERSION = 1;

	private static final Set<String> COMPARISON_BASES = Set.of("CHANGE", "OBSERVATION_DIFFERENCE");

	private static final Set<String> SCOPES = Set.of("COMPLETE_RESULT", "OBSERVED_BUILDINGS_ONLY");

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
