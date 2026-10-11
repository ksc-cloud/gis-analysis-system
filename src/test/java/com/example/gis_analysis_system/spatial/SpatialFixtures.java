package com.example.gis_analysis_system.spatial;

import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Center;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.FloorStatistics;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Summary;
import com.example.gis_analysis_system.analysis.RadiusAnalysisService;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

/** Radius analysis results for the spatial analysis tests. */
final class SpatialFixtures {

	static final double LON = 126.978;

	static final double LAT = 37.5665;

	static final String TOKEN = "test-internal-token-7f3a";

	private SpatialFixtures() {
	}

	/**
	 * A result of the real {@link RadiusAnalysisService} with mocked VWorld pages: a bd: building with a hole and a
	 * second part containing the center, a PARTIAL feature: building with "0" floors, a row: building, another bd:
	 * building, one outside the circle (excluded by Java) and the page limit (complete=false, PAGE_LIMIT).
	 */
	static RadiusAnalysisResult liveResult() {
		BuildingFeature withHole = new BuildingFeature("LT_C_SPBD.1",
				new BuildingInfo("1114010300100310000000001", "서울특별시청", "본관", "13", "서울특별시", "중구", "태평로1가", "세종대로",
						"110"),
				List.of(new double[][][] { square(LON, LAT, 0.0002), square(LON + 0.0001, LAT + 0.0001, 0.00004) },
						new double[][][] { square(LON + 0.0005, LAT, 0.00005) }));
		BuildingFeature partialWithoutNumber = new BuildingFeature("LT_C_SPBD.2",
				new BuildingInfo(null, "경계 건물", null, "0", "서울특별시", "중구", null, "세종대로", "112"),
				List.<double[][][]>of(new double[][][] { square(LON, LAT + 0.0009, 0.00005) }));
		BuildingFeature withoutIdentifiers = new BuildingFeature(null,
				new BuildingInfo(null, null, null, "25", null, null, null, null, null),
				List.<double[][][]>of(new double[][][] { square(LON, LAT + 0.0003, 0.00003) }));
		BuildingFeature low = new BuildingFeature("LT_C_SPBD.4",
				new BuildingInfo("1114010300100310000000004", "별관", null, null, "서울특별시", "중구", "태평로1가", "세종대로",
						"114"),
				List.<double[][][]>of(new double[][][] { square(LON - 0.0004, LAT, 0.00003) }));
		BuildingFeature outside = new BuildingFeature("LT_C_SPBD.5",
				new BuildingInfo("1114010300100310000000005", "먼 건물", null, "5", "서울특별시", "중구", null, null, null),
				List.<double[][][]>of(new double[][][] { square(LON, LAT + 0.002, 0.00003) }));
		List<BuildingFeature> features = List.of(withHole, partialWithoutNumber, withoutIdentifiers, low, outside);

		VWorldBuildingClient client = mock(VWorldBuildingClient.class);
		for (int page = 1; page <= 5; page++) {
			given(client.findBuildingsWithin(anyDouble(), anyDouble(), anyInt(), eq(page)))
				.willReturn(new FeaturePage(7000, 7, page, features));
		}
		return new RadiusAnalysisService(client).analyze(LON, LAT, 100);
	}

	/**
	 * A complete 1 km result with {@code count} bd: buildings on a grid. {@code version} shifts every 10th building's
	 * floors, so two versions compare as modified buildings.
	 */
	static RadiusAnalysisResult syntheticResult(int count, int version) {
		List<AnalyzedBuilding> buildings = new ArrayList<>();
		for (int i = 0; i < count; i++) {
			double lon = LON + ((i % 70) - 35) * 0.00015;
			double lat = LAT + ((i / 70) - 35) * 0.00015;
			String floors = String.valueOf(1 + (i % 30) + ((i % 10 == 0) ? version : 0));
			String id = "bd:" + String.format("%025d", 1_000_000L + i);
			buildings.add(new AnalyzedBuilding(id,
					new BuildingInfo(id.substring(3), "건물 " + i, null, floors, "서울특별시", "중구", null, null, null),
					Relation.INSIDE, 1.0, false, false,
					List.<double[][][]>of(new double[][][] { square(lon, lat, 0.00005) })));
		}
		Summary summary = new Summary(count, count, 0, 0, 0, count, 0);
		FloorStatistics floors = RadiusAnalysisService.floorStatistics(0, count, null, null, 0, new int[5]);
		return new RadiusAnalysisResult(new Center(LON, LAT), 1000, RadiusAnalysisResult.CRITERION,
				RadiusAnalysisService.CRITERION_DESCRIPTION, RadiusAnalysisService.DISTANCE_DESCRIPTION, true, List.of(),
				count, count, Math.max(1, (count + 999) / 1000), Math.max(1, (count + 999) / 1000), summary, floors,
				List.copyOf(buildings), RadiusAnalysisService.DATA_SOURCE);
	}

	static AnalysisDetail detail(long analysisId, String analyzedAt, RadiusAnalysisResult result) {
		Instant at = Instant.parse(analyzedAt);
		return new AnalysisDetail(analysisId, "분석 " + analysisId, at, at.plusSeconds(60), result);
	}

	/** Closed square ring, coordinates rounded to 7 decimals like the live result. */
	static double[][] square(double lon, double lat, double half) {
		double w = Math.round((lon - half) * 1e7) / 1e7;
		double e = Math.round((lon + half) * 1e7) / 1e7;
		double s = Math.round((lat - half) * 1e7) / 1e7;
		double n = Math.round((lat + half) * 1e7) / 1e7;
		return new double[][] { { w, s }, { e, s }, { e, n }, { w, n }, { w, s } };
	}

	static String buildingStatsResponse() {
		return """
				{"schemaVersion": 1, "source": null, "center": {"lon": 126.978, "lat": 37.5665}, "radiusMeters": 100,
				 "method": {"projection": "LOCAL_TANGENT_PLANE_WGS84"},
				 "counts": {"total": 1, "analyzed": 1, "excluded": 0},
				 "footprint": {"sumArea": 200.0, "unionArea": 200.0},
				 "withinRadius": {"unionArea": 200.0, "coverageRatio": 0.006366},
				 "floors": {"withData": 1, "withoutData": 0},
				 "completeness": {"complete": true, "scope": "COMPLETE_RESULT", "reasons": [], "notes": []},
				 "warnings": [], "excluded": [], "buildings": null}""";
	}

	static String gridDensityResponse() {
		return """
				{"schemaVersion": 1, "radiusMeters": 100, "cellSizeMeters": 100, "method": {},
				 "grid": {"cellCount": 1, "returnedCellCount": 1},
				 "counts": {"total": 1, "analyzed": 1, "excluded": 0},
				 "summary": {"occupiedArea": 200.0, "coverageRatio": 0.006366},
				 "consistency": {"occupiedAreaMatches": true, "primaryMatchesAnalyzed": true},
				 "completeness": {"complete": true, "scope": "COMPLETE_RESULT", "notes": []},
				 "warnings": [], "excluded": [],
				 "cells": {"type": "FeatureCollection", "features": [
				   {"type": "Feature", "id": "0:0",
				    "geometry": {"type": "Polygon", "coordinates": [[[126.97, 37.56], [126.98, 37.56], [126.98, 37.57],
				                                                       [126.97, 37.56]]]},
				    "properties": {"buildingCount": 1, "coverageRatio": 0.02}}]}}""";
	}

	/** Python hotspot statuses and the two kinds of blocking used by {@link #hotspotResponse(String)}. */
	static final String HOTSPOT_OK = "OK";

	static final String HOTSPOT_CONSTANT = "CONSTANT_VALUES";

	static final String HOTSPOT_INSUFFICIENT = "INSUFFICIENT_CELLS";

	static final String HOTSPOT_BLOCKED = "PARTIAL_RESULT_BLOCKED";

	/** Blocked by Python after the grid: a building it could not repair (Java's analysis was complete). */
	static final String HOTSPOT_GEOMETRY_BLOCKED = "PYTHON_GEOMETRY_EXCLUDED";

	private static final String HOTSPOT_POLYGON = """
			{"type": "Polygon", "coordinates": [[[126.97, 37.56], [126.98, 37.56], [126.98, 37.57], [126.97, 37.56]]]}""";

	/**
	 * A response shaped like analysis-service/app/schemas/hotspot.py: three cells (two tested and one small boundary
	 * cell for OK, all NOT_TESTED for CONSTANT_VALUES and INSUFFICIENT_CELLS), or a blocked result.
	 */
	static String hotspotResponse(String kind) {
		boolean blocked = HOTSPOT_BLOCKED.equals(kind) || HOTSPOT_GEOMETRY_BLOCKED.equals(kind);
		String status = blocked ? HOTSPOT_BLOCKED : kind;
		String blockedReasons = HOTSPOT_BLOCKED.equals(kind) ? "[\"PAGE_LIMIT\"]"
				: HOTSPOT_GEOMETRY_BLOCKED.equals(kind) ? "[\"PYTHON_GEOMETRY_EXCLUDED\"]" : "[]";
		String completeness = HOTSPOT_BLOCKED.equals(kind)
				? """
						{"complete": false, "scope": "OBSERVED_BUILDINGS_ONLY", "reasons": [{"code": "PAGE_LIMIT", "message": "x"}],
						 "javaOutsideExcluded": 1, "javaGeometryUnavailable": 0, "notes": [],
						 "sourceComplete": false, "pythonGeometryExcluded": null}"""
				: HOTSPOT_GEOMETRY_BLOCKED.equals(kind) ? """
						{"complete": false, "scope": "OBSERVED_BUILDINGS_ONLY", "reasons": [],
						 "javaOutsideExcluded": 0, "javaGeometryUnavailable": 0, "notes": [],
						 "sourceComplete": true, "pythonGeometryExcluded": 1}"""
						: """
								{"complete": true, "scope": "COMPLETE_RESULT", "reasons": [],
								 "javaOutsideExcluded": 0, "javaGeometryUnavailable": 0, "notes": [],
								 "sourceComplete": true, "pythonGeometryExcluded": 0}""";
		if (blocked) {
			return """
					{"schemaVersion": 1, "source": null, "center": {"lon": 126.978, "lat": 37.5665}, "radiusMeters": 300,
					 "cellSizeMeters": 50, "status": "%s", "blockedReasons": %s, "method": {"statistic": "GETIS_ORD_GI_STAR"},
					 "grid": null, "counts": null, "moran": null,
					 "summary": {"cellCount": 0, "studyCellCount": 0, "testedCellCount": 0,
					   "classes": {"HOT_99": 0, "HOT_95": 0, "HOT_90": 0, "NOT_SIGNIFICANT": 0, "COLD_90": 0, "COLD_95": 0,
					               "COLD_99": 0, "NOT_TESTED": 0},
					   "notTestedReasons": {"SMALL_BOUNDARY": 0}},
					 "completeness": %s,
					 "warnings": [{"code": "PARTIAL_RESULT_BLOCKED", "message": "x"}],
					 "cells": {"type": "FeatureCollection", "features": []}}"""
				.formatted(status, blockedReasons, completeness);
		}
		boolean ok = HOTSPOT_OK.equals(kind);
		String first = ok ? """
				"neighborCount": 8, "giZ": 3.1, "pValue": 0.00194, "qValue": 0.0058, "hotspotClass": "HOT_99", "bin": 3, "reason": null"""
				: """
						"neighborCount": 8, "giZ": null, "pValue": null, "qValue": null, "hotspotClass": "NOT_TESTED", "bin": null, "reason": "%s\""""
					.formatted(kind);
		String second = ok ? """
				"neighborCount": 5, "giZ": -0.5, "pValue": 0.617, "qValue": 0.617, "hotspotClass": "NOT_SIGNIFICANT", "bin": 0, "reason": null"""
				: """
						"neighborCount": 5, "giZ": null, "pValue": null, "qValue": null, "hotspotClass": "NOT_TESTED", "bin": null, "reason": "%s\""""
					.formatted(kind);
		String third = """
				"neighborCount": null, "giZ": null, "pValue": null, "qValue": null, "hotspotClass": "NOT_TESTED", "bin": null, "reason": "SMALL_BOUNDARY\"""";
		String moran = ok ? """
				{"i": 0.21, "expected": -0.5, "pValue": 0.001, "zSimulated": 4.2, "simulatedMean": -0.49, "simulatedSd": 0.12}"""
				: "null";
		String classes = ok ? "\"HOT_99\": 1, \"NOT_SIGNIFICANT\": 1, \"NOT_TESTED\": 1"
				: "\"HOT_99\": 0, \"NOT_SIGNIFICANT\": 0, \"NOT_TESTED\": 3";
		StringBuilder features = new StringBuilder();
		String[][] cells = { { "0:0", first }, { "1:0", second }, { "2:0", third } };
		for (String[] cell : cells) {
			int col = Integer.parseInt(cell[0].split(":")[0]);
			features.append((features.length() > 0) ? ",\n" : "")
				.append("{\"type\": \"Feature\", \"id\": \"")
				.append(cell[0])
				.append("\", \"geometry\": ")
				.append(HOTSPOT_POLYGON)
				.append(", \"properties\": {\"col\": ")
				.append(col)
				.append(", \"row\": 0, \"centerLon\": 126.978, \"centerLat\": 37.5665, \"boundary\": false, ")
				.append("\"smallBoundary\": ")
				.append(col == 2)
				.append(", \"domainRatio\": 1.0, \"coverageRatio\": 0.2, ")
				.append(cell[1])
				.append("}}");
		}
		return """
				{"schemaVersion": 1, "source": null, "center": {"lon": 126.978, "lat": 37.5665}, "radiusMeters": 300,
				 "cellSizeMeters": 50, "status": "%s", "blockedReasons": [], "method": {"statistic": "GETIS_ORD_GI_STAR"},
				 "grid": {"cellSizeMeters": 50, "cellCount": 3, "returnedCellCount": 3},
				 "counts": {"total": 2, "analyzed": 2, "excluded": 0},
				 "moran": %s,
				 "summary": {"cellCount": 3, "studyCellCount": 2, "testedCellCount": %d,
				   "classes": {%s, "HOT_95": 0, "HOT_90": 0, "COLD_90": 0, "COLD_95": 0, "COLD_99": 0},
				   "notTestedReasons": {"SMALL_BOUNDARY": 1}},
				 "completeness": %s,
				 "warnings": [],
				 "cells": {"type": "FeatureCollection", "features": [
				 %s]}}"""
			.formatted(status, moran, ok ? 2 : 0, classes, completeness, features);
	}

	static String compareResponse(boolean comparable) {
		String statistics = comparable
				? "{\"buildingCount\": {\"before\": 1, \"after\": 1}, \"unionArea\": {}, \"coverageRatio\": {}}" : "null";
		String buildings = comparable ? "{\"summary\": {\"matched\": 1}, \"changes\": []}" : "null";
		return """
				{"schemaVersion": 1, "comparable": %s, "comparisonBasis": "CHANGE", "notComparableReasons": [],
				 "before": {"source": {"kind": "SAVED"}, "counts": {"total": 1, "analyzed": 1, "excluded": 0}},
				 "after": {"source": {"kind": "SAVED"}, "counts": {"total": 1, "analyzed": 1, "excluded": 0}},
				 "conditions": {}, "method": {}, "statistics": %s, "buildings": %s, "warnings": [], "notes": []}"""
			.formatted(comparable, statistics, buildings);
	}

}
