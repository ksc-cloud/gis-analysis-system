package com.example.gis_analysis_system.history;

import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;

import java.util.ArrayList;
import java.util.List;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Center;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.FloorStatistics;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Summary;
import com.example.gis_analysis_system.analysis.RadiusAnalysisService;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

/** Radius analysis results for history tests. */
final class AnalysisFixtures {

	static final double LON = 126.978;

	static final double LAT = 37.5665;

	private AnalysisFixtures() {
	}

	/**
	 * A result produced by the real {@link RadiusAnalysisService} (mocked VWorld): a building containing the center
	 * whose footprint has a hole and a second part, a PARTIAL building without bd_mgt_sn and with "0" floors, a
	 * building without any identifier, an excluded one outside the circle, and an incomplete result (page limit).
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
				new BuildingInfo("1114010300100310000000004", "별관", null, "3", "서울특별시", "중구", "태평로1가", "세종대로", "114"),
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

	/** A complete result with {@code count} small buildings, for batch tests. */
	static RadiusAnalysisResult syntheticResult(int count) {
		List<AnalyzedBuilding> buildings = new ArrayList<>();
		for (int i = 0; i < count; i++) {
			double lon = Math.round((LON + (i % 70) * 0.00001) * 1e7) / 1e7;
			double lat = Math.round((LAT + (i / 70) * 0.00001) * 1e7) / 1e7;
			String floors = String.valueOf(1 + (i % 30));
			buildings.add(new AnalyzedBuilding("feature:LT_C_SPBD." + i,
					new BuildingInfo(null, "건물 " + i, null, floors, "서울특별시", "중구", null, null, null),
					(i % 2 == 0) ? Relation.INSIDE : Relation.PARTIAL, Math.round((i * 0.37) % 1000 * 100) / 100.0,
					false, false, List.<double[][][]>of(new double[][][] { square(lon, lat, 0.000004) })));
		}
		int inside = (count + 1) / 2;
		Summary summary = new Summary(count, inside, count - inside, 0, 0, count, 0);
		FloorStatistics floors = RadiusAnalysisService.floorStatistics(0, count, null, null, 0, new int[5]);
		return new RadiusAnalysisResult(new Center(LON, LAT), 1000, RadiusAnalysisResult.CRITERION,
				RadiusAnalysisService.CRITERION_DESCRIPTION, RadiusAnalysisService.DISTANCE_DESCRIPTION, true, List.of(),
				count, count, Math.max(1, (count + 999) / 1000), Math.max(1, (count + 999) / 1000), summary, floors,
				List.copyOf(buildings), RadiusAnalysisService.DATA_SOURCE);
	}

	/** Closed square ring, coordinates rounded to 7 decimals like the live result. */
	static double[][] square(double lon, double lat, double half) {
		double w = Math.round((lon - half) * 1e7) / 1e7;
		double e = Math.round((lon + half) * 1e7) / 1e7;
		double s = Math.round((lat - half) * 1e7) / 1e7;
		double n = Math.round((lat + half) * 1e7) / 1e7;
		return new double[][] { { w, s }, { e, s }, { e, n }, { w, n }, { w, s } };
	}

}
