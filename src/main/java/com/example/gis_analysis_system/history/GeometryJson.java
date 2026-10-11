package com.example.gis_analysis_system.history;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Converts building footprints ({@code polygons[rings[points[lon, lat]]]}) to and from a GeoJSON MultiPolygon.
 * Inner rings (holes) and every coordinate digit are kept: doubles are written in their shortest exact form and read
 * back to the same values.
 */
final class GeometryJson {

	static final String TYPE = "MultiPolygon";

	private final JsonMapper jsonMapper;

	GeometryJson(JsonMapper jsonMapper) {
		this.jsonMapper = jsonMapper;
	}

	String write(List<double[][][]> polygons) {
		if (polygons == null || polygons.isEmpty()) {
			throw new IllegalArgumentException("a building needs at least one polygon");
		}
		Map<String, Object> geoJson = new LinkedHashMap<>();
		geoJson.put("type", TYPE);
		geoJson.put("coordinates", polygons);
		return this.jsonMapper.writeValueAsString(geoJson);
	}

	/** @throws IllegalStateException if the stored value is not a MultiPolygon with closed rings of 4+ points */
	List<double[][][]> read(String json) {
		JsonNode root = this.jsonMapper.readTree(json);
		if (!TYPE.equals(root.path("type").asString(null))) {
			throw new IllegalStateException("stored geometry is not a " + TYPE);
		}
		JsonNode coordinates = root.path("coordinates");
		if (!coordinates.isArray() || coordinates.isEmpty()) {
			throw new IllegalStateException("stored geometry has no polygons");
		}
		List<double[][][]> polygons = new ArrayList<>(coordinates.size());
		for (JsonNode polygonNode : coordinates) {
			if (!polygonNode.isArray() || polygonNode.isEmpty()) {
				throw new IllegalStateException("stored polygon has no rings");
			}
			double[][][] polygon = new double[polygonNode.size()][][];
			for (int r = 0; r < polygon.length; r++) {
				JsonNode ringNode = polygonNode.get(r);
				if (!ringNode.isArray() || ringNode.size() < 4) {
					throw new IllegalStateException("stored ring has fewer than 4 points");
				}
				double[][] ring = new double[ringNode.size()][];
				for (int p = 0; p < ring.length; p++) {
					JsonNode point = ringNode.get(p);
					if (!point.isArray() || point.size() != 2 || !point.get(0).isNumber() || !point.get(1).isNumber()) {
						throw new IllegalStateException("stored point is not [lon, lat]");
					}
					ring[p] = new double[] { point.get(0).doubleValue(), point.get(1).doubleValue() };
				}
				polygon[r] = ring;
			}
			polygons.add(polygon);
		}
		return List.copyOf(polygons);
	}

}
