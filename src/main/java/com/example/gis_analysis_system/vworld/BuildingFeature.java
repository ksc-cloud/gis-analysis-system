package com.example.gis_analysis_system.vworld;

import java.util.List;

/**
 * One LT_C_SPBD feature returned with geometry=true.
 * Real responses (checked with a real key) return every footprint as a GeoJSON MultiPolygon in EPSG:4326,
 * and some polygons have inner rings (holes).
 *
 * @param featureId GeoJSON feature id (for example {@code LT_C_SPBD.1110133463}), or {@code null}
 * @param building attributes of the feature
 * @param polygons footprint polygons; each polygon is {@code rings[points[lon, lat]]} with the outer ring first
 * and closed rings. {@code null} when the geometry is missing or could not be read safely
 */
public record BuildingFeature(String featureId, BuildingInfo building, List<double[][][]> polygons) {

	public boolean hasGeometry() {
		return this.polygons != null && !this.polygons.isEmpty();
	}

}
