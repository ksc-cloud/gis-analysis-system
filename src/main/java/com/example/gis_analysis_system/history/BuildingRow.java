package com.example.gis_analysis_system.history;

import java.math.BigDecimal;

/**
 * One row of gis_analysis_building.
 *
 * @param buildingKey {@code bd:<bd_mgt_sn>}, {@code feature:<id>} or {@code row:<index>} (the live result's id)
 * @param groundFloorRaw gro_flo_co as returned by VWorld
 * @param groundFloorCount the same value when it is a whole number of at least 1, otherwise {@code null}
 * @param geometry GeoJSON MultiPolygon
 */
public record BuildingRow(long analysisId, int seq, String buildingKey, String bdMgtSn, String buildingName,
		String buildingSubName, String sido, String sigungu, String eupmyeon, String roadName, String buildingNumber,
		String groundFloorRaw, Integer groundFloorCount, String relation, BigDecimal distanceM, boolean centerInside,
		boolean hasHoles, String geometry) {

}
