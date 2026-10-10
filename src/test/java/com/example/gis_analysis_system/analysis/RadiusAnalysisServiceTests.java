package com.example.gis_analysis_system.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.ReasonCode;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

class RadiusAnalysisServiceTests {

	private static final double LON = 126.978;

	private static final double LAT = 37.5665;

	private final PlanarGeometry.LocalProjection projection = new PlanarGeometry.LocalProjection(LON, LAT);

	private final VWorldBuildingClient client = mock(VWorldBuildingClient.class);

	private final AtomicLong clock = new AtomicLong();

	private final RadiusAnalysisService service = new RadiusAnalysisService(this.client, this.clock::get);

	@Test
	void classifiesSortsAndCountsBuildings() {
		pages(new FeaturePage(4, 1, 1, List.of(feature("A", "12", square(90, 0, 20)), // crosses r=100
				feature("B", "0", square(30, 0, 10)), // inside
				feature("C", "abc", square(300, 0, 10)), // returned but outside
				feature("D", "5", square(0, 0, 5))))); // contains the center

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isTrue();
		assertThat(result.incompleteReasons()).isEmpty();
		assertThat(result.reportedTotal()).isEqualTo(4);
		assertThat(result.fetchedFeatures()).isEqualTo(4);
		assertThat(result.criterion()).isEqualTo("POLYGON_INTERSECTS_CIRCLE");
		assertThat(result.buildings()).extracting((b) -> b.building().buildingManagementNumber())
			.containsExactly("D", "B", "A");
		assertThat(result.buildings()).extracting(RadiusAnalysisResult.AnalyzedBuilding::relation)
			.containsExactly(Relation.INSIDE, Relation.INSIDE, Relation.PARTIAL);
		assertThat(result.buildings().get(0).distanceMeters()).isZero();
		assertThat(result.buildings().get(0).centerInside()).isTrue();
		assertThat(result.buildings().get(1).distanceMeters()).isEqualTo(20.0);
		assertThat(result.buildings().get(2).id()).isEqualTo("bd:A");
		assertThat(result.summary().intersecting()).isEqualTo(3);
		assertThat(result.summary().inside()).isEqualTo(2);
		assertThat(result.summary().partial()).isEqualTo(1);
		assertThat(result.summary().outsideExcluded()).isEqualTo(1);
		// "0" is treated as missing data, like on the building panel.
		assertThat(result.floorStatistics().withData()).isEqualTo(2);
		assertThat(result.floorStatistics().withoutData()).isEqualTo(1);
		assertThat(result.floorStatistics().min()).isEqualTo(5);
		assertThat(result.floorStatistics().max()).isEqualTo(12);
		assertThat(result.floorStatistics().average()).isEqualTo(8.5);
		assertThat(result.floorStatistics().distribution()).extracting(RadiusAnalysisResult.FloorBucket::count)
			.containsExactly(0, 1, 0, 1, 0);
		assertThat(result.source().layer()).contains("LT_C_SPBD");
	}

	@Test
	void notFoundIsACompleteEmptyResult() {
		pages(new FeaturePage(0, 0, 1, List.of()));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 500);

		assertThat(result.complete()).isTrue();
		assertThat(result.buildings()).isEmpty();
		assertThat(result.reportedTotal()).isZero();
		assertThat(result.floorStatistics().average()).isNull();
	}

	@Test
	void fetchesEveryReportedPage() {
		pages(new FeaturePage(3, 3, 1, List.of(feature("1", "1", square(10, 0, 2)))),
				new FeaturePage(3, 3, 2, List.of(feature("2", "1", square(20, 0, 2)))),
				new FeaturePage(3, 3, 3, List.of(feature("3", "1", square(30, 0, 2)))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isTrue();
		assertThat(result.fetchedPages()).isEqualTo(3);
		assertThat(result.reportedPages()).isEqualTo(3);
		assertThat(result.buildings()).hasSize(3);
		then(this.client).should(times(3)).findBuildingsWithin(eq(LON), eq(LAT), eq(100), anyInt());
	}

	@Test
	void stopsAtThePageLimit() {
		for (int page = 1; page <= 5; page++) {
			given(this.client.findBuildingsWithin(LON, LAT, 1000, page)).willReturn(
					new FeaturePage(7000, 7, page, List.of(feature("p" + page, "1", square(page * 10, 0, 2)))));
		}

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 1000);

		assertThat(result.complete()).isFalse();
		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.PAGE_LIMIT);
		assertThat(result.reportedTotal()).isEqualTo(7000);
		assertThat(result.fetchedPages()).isEqualTo(5);
		then(this.client).should(never()).findBuildingsWithin(LON, LAT, 1000, 6);
	}

	@Test
	void clampedPageIsNotCountedTwice() {
		// VWorld answers a page beyond the last one with the last page.
		pages(new FeaturePage(2000, 2, 1, List.of(feature("1", "1", square(10, 0, 2)))),
				new FeaturePage(2000, 2, 1, List.of(feature("1", "1", square(10, 0, 2)))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isFalse();
		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.PAGINATION_INCONSISTENT);
		assertThat(result.fetchedFeatures()).isEqualTo(1);
	}

	@Test
	void laterPageFailureKeepsEarlierPagesAsPartialResult() {
		given(this.client.findBuildingsWithin(LON, LAT, 100, 1))
			.willReturn(new FeaturePage(2000, 2, 1, List.of(feature("1", "1", square(10, 0, 2)))));
		given(this.client.findBuildingsWithin(LON, LAT, 100, 2))
			.willThrow(new VWorldApiException(VWorldApiException.Reason.API_ERROR, "SYSTEM_ERROR", "오류"));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isFalse();
		assertThat(result.incompleteReasons()).singleElement().satisfies((reason) -> {
			assertThat(reason.code()).isEqualTo(ReasonCode.EXTERNAL_API_ERROR);
			assertThat(reason.message()).contains("2페이지").contains("SYSTEM_ERROR");
		});
		assertThat(result.buildings()).hasSize(1);
	}

	@Test
	void laterPageTimeoutIsReported() {
		given(this.client.findBuildingsWithin(LON, LAT, 100, 1))
			.willReturn(new FeaturePage(2000, 2, 1, List.of(feature("1", "1", square(10, 0, 2)))));
		given(this.client.findBuildingsWithin(LON, LAT, 100, 2))
			.willThrow(new VWorldApiException(VWorldApiException.Reason.TIMEOUT, null, "시간 초과"));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.EXTERNAL_API_TIMEOUT);
	}

	@Test
	void firstPageFailureIsAnError() {
		given(this.client.findBuildingsWithin(LON, LAT, 100, 1))
			.willThrow(new VWorldApiException(VWorldApiException.Reason.TIMEOUT, null, "시간 초과"));

		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> this.service.analyze(LON, LAT, 100))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.TIMEOUT));
	}

	@Test
	void stopsWhenTheTimeBudgetRunsOut() {
		given(this.client.findBuildingsWithin(LON, LAT, 100, 1)).willAnswer((invocation) -> {
			this.clock.addAndGet(RadiusAnalysisService.TIME_BUDGET.toNanos() + 1);
			return new FeaturePage(3000, 3, 1, List.of(feature("1", "1", square(10, 0, 2))));
		});

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isFalse();
		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.TIME_LIMIT);
		then(this.client).should(never()).findBuildingsWithin(LON, LAT, 100, 2);
	}

	@Test
	void mergesDuplicatesWithoutJoiningDifferentBuildings() {
		double[][][] first = square(10, 0, 2);
		double[][][] second = square(20, 0, 2);
		pages(new FeaturePage(7, 1, 1, List.of(feature("SAME", "3", first), feature("SAME", "3", first), // exact copy
				feature("SAME", "3", second), // same building, second footprint
				new BuildingFeature("LT_C_SPBD.9", building(null, "1"), List.<double[][][]>of(square(30, 0, 2))),
				new BuildingFeature("LT_C_SPBD.9", building(null, "1"), List.<double[][][]>of(square(30, 0, 2))),
				new BuildingFeature(null, building(null, "1"), List.<double[][][]>of(square(40, 0, 2))),
				new BuildingFeature(null, building(null, "1"), List.<double[][][]>of(square(40, 0, 2))))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.summary().distinctBuildings()).isEqualTo(4);
		assertThat(result.summary().mergedDuplicateFeatures()).isEqualTo(3);
		assertThat(result.buildings()).extracting(RadiusAnalysisResult.AnalyzedBuilding::id)
			.containsExactly("bd:SAME", "feature:LT_C_SPBD.9", "row:5", "row:6");
		assertThat(result.buildings().get(0).polygons()).hasSize(2);
		assertThat(result.complete()).isTrue();
	}

	@Test
	void buildingsWithoutGeometryMakeTheResultIncomplete() {
		pages(new FeaturePage(2, 1, 1, List.of(feature("A", "1", square(10, 0, 2)),
				new BuildingFeature("LT_C_SPBD.2", building("B", "1"), null))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isFalse();
		assertThat(result.summary().geometryUnavailable()).isEqualTo(1);
		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.GEOMETRY_UNAVAILABLE);
		assertThat(result.buildings()).hasSize(1);
	}

	@Test
	void fewerFeaturesThanReportedIsIncomplete() {
		pages(new FeaturePage(5, 1, 1, List.of(feature("A", "1", square(10, 0, 2)))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.COUNT_MISMATCH);
	}

	@Test
	void unknownTotalCannotBeConfirmedComplete() {
		pages(new FeaturePage(-1, -1, -1, List.of(feature("A", "1", square(10, 0, 2)))));

		RadiusAnalysisResult result = this.service.analyze(LON, LAT, 100);

		assertThat(result.complete()).isFalse();
		assertThat(result.reportedTotal()).isNull();
		assertThat(result.incompleteReasons()).extracting(RadiusAnalysisResult.IncompleteReason::code)
			.containsExactly(ReasonCode.TOTAL_UNKNOWN);
	}

	@Test
	void rejectsRadiusOutsideTheSupportedRange() {
		assertThatExceptionOfType(IllegalArgumentException.class).isThrownBy(() -> this.service.analyze(LON, LAT, 49));
		assertThatExceptionOfType(IllegalArgumentException.class)
			.isThrownBy(() -> this.service.analyze(LON, LAT, 1001));
		then(this.client).should(never()).findBuildingsWithin(anyDouble(), anyDouble(), anyInt(), anyInt());
	}

	@Test
	void validFloorsAreWholeNumbersOfAtLeastOne() {
		assertThat(RadiusAnalysisService.validFloors("12")).isEqualTo(12);
		assertThat(RadiusAnalysisService.validFloors("0")).isNull();
		assertThat(RadiusAnalysisService.validFloors("-1")).isNull();
		assertThat(RadiusAnalysisService.validFloors("3.5")).isNull();
		assertThat(RadiusAnalysisService.validFloors(null)).isNull();
	}

	private void pages(FeaturePage... pages) {
		for (int i = 0; i < pages.length; i++) {
			given(this.client.findBuildingsWithin(eq(LON), eq(LAT), anyInt(), eq(i + 1))).willReturn(pages[i]);
		}
	}

	private BuildingFeature feature(String managementNumber, String floors, double[][][] polygon) {
		return new BuildingFeature("LT_C_SPBD." + managementNumber, building(managementNumber, floors),
				List.<double[][][]>of(polygon));
	}

	private static BuildingInfo building(String managementNumber, String floors) {
		return new BuildingInfo(managementNumber, null, null, floors, "서울특별시", "중구", null, "세종대로", "1");
	}

	private double[][][] square(double cx, double cy, double half) {
		List<double[]> ring = new ArrayList<>();
		double[][] corners = { { cx - half, cy - half }, { cx + half, cy - half }, { cx + half, cy + half },
				{ cx - half, cy + half }, { cx - half, cy - half } };
		for (double[] corner : corners) {
			ring.add(new double[] { this.projection.lon(corner[0]), this.projection.lat(corner[1]) });
		}
		return new double[][][] { ring.toArray(new double[0][]) };
	}

}
