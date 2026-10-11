package com.example.gis_analysis_system.analysis;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Center;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.DataSource;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.FloorBucket;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.FloorStatistics;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.IncompleteReason;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.ReasonCode;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Relation;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.Summary;
import com.example.gis_analysis_system.vworld.BuildingFeature;
import com.example.gis_analysis_system.vworld.BuildingInfo;
import com.example.gis_analysis_system.vworld.VWorldApiException;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient;
import com.example.gis_analysis_system.vworld.VWorldBuildingClient.FeaturePage;

/**
 * Collects LT_C_SPBD buildings around a point with VWorld's POINT + buffer filter and re-checks every footprint
 * on the server (polygon intersects circle, holes respected).
 * <p>
 * A failure of the first page is an error. Failures after that keep the pages already received and are reported
 * as an incomplete result, so a partial count is never presented as the total for the area.
 */
@Service
public class RadiusAnalysisService {

	public static final int MIN_RADIUS = 50;

	public static final int MAX_RADIUS = 1000;

	static final int MAX_PAGES = 5;

	/** No new page is requested after this; a page already in flight is bounded by the client's read timeout. */
	static final Duration TIME_BUDGET = Duration.ofSeconds(20);

	private static final int[][] FLOOR_BUCKETS = { { 1, 2 }, { 3, 5 }, { 6, 10 }, { 11, 20 }, { 21, -1 } };

	/** Shared with saved analyses so a restored result reads exactly like a live one. */
	public static final String CRITERION_DESCRIPTION = "건물 다각형이 반경 원과 일부라도 겹치면 포함합니다. "
			+ "다각형 전체가 원 안이면 완전 포함(INSIDE), 일부만 겹치거나 경계에 접하면 경계 걸침(PARTIAL)입니다. "
			+ "내부 구멍은 건물 밖으로 판정합니다.";

	public static final String DISTANCE_DESCRIPTION = "중심점에서 건물 다각형까지의 최단 수평거리(m)입니다. "
			+ "중심점이 건물 안이면 0m이며, 지형을 반영한 실제 이동 거리가 아닙니다.";

	public static final DataSource DATA_SOURCE = new DataSource("VWorld 2D 데이터 API", "LT_C_SPBD (도로명주소 건물)",
			"EPSG:4326 (WGS84 경위도)", "건물 용도와 준공연도는 이 데이터에서 제공하지 않습니다. 3D 건물 모델과 정확히 일치하지 않을 수 있습니다.");

	private final VWorldBuildingClient client;

	private final LongSupplier nanoClock;

	@Autowired
	public RadiusAnalysisService(VWorldBuildingClient client) {
		this(client, System::nanoTime);
	}

	RadiusAnalysisService(VWorldBuildingClient client, LongSupplier nanoClock) {
		this.client = client;
		this.nanoClock = nanoClock;
	}

	public RadiusAnalysisResult analyze(double lon, double lat, int radiusMeters) {
		if (radiusMeters < MIN_RADIUS || radiusMeters > MAX_RADIUS) {
			throw new IllegalArgumentException("radius out of range");
		}
		Map<ReasonCode, IncompleteReason> reasons = new LinkedHashMap<>();
		List<BuildingFeature> collected = new ArrayList<>();
		long start = this.nanoClock.getAsLong();
		Integer reportedTotal = null;
		Integer reportedPages = null;
		int fetchedPages = 0;

		for (int page = 1;; page++) {
			if (page > MAX_PAGES) {
				addReason(reasons, ReasonCode.PAGE_LIMIT, "조회 한도(" + MAX_PAGES + "페이지, 최대 "
						+ (MAX_PAGES * VWorldBuildingClient.MAX_PAGE_SIZE) + "건)를 넘어 나머지 건물은 조회하지 않았습니다.");
				break;
			}
			if (page > 1 && this.nanoClock.getAsLong() - start >= TIME_BUDGET.toNanos()) {
				addReason(reasons, ReasonCode.TIME_LIMIT,
						"분석 시간 한도(" + TIME_BUDGET.toSeconds() + "초)를 넘어 " + page + "페이지부터 조회하지 않았습니다.");
				break;
			}
			FeaturePage result;
			try {
				result = this.client.findBuildingsWithin(lon, lat, radiusMeters, page);
			}
			catch (VWorldApiException ex) {
				if (page == 1) {
					throw ex;
				}
				boolean timeout = ex.getReason() == VWorldApiException.Reason.TIMEOUT;
				String code = (ex.getVworldErrorCode() != null) ? " (" + ex.getVworldErrorCode() + ")" : "";
				addReason(reasons, timeout ? ReasonCode.EXTERNAL_API_TIMEOUT : ReasonCode.EXTERNAL_API_ERROR,
						page + "페이지 조회 " + (timeout ? "시간이 초과되었습니다." : "중 오류가 발생했습니다" + code + ".")
								+ " 이전 페이지까지의 결과만 표시합니다.");
				break;
			}
			if (page == 1) {
				reportedTotal = (result.reportedTotal() >= 0) ? result.reportedTotal() : null;
				reportedPages = (result.totalPages() >= 0) ? result.totalPages() : null;
			}
			else {
				if (result.currentPage() != page) {
					// VWorld answers a page beyond the last one with the last page; never count it twice.
					addReason(reasons, ReasonCode.PAGINATION_INCONSISTENT,
							page + "페이지 요청에 다른 페이지(" + result.currentPage() + ")가 응답되어 조회를 중단했습니다.");
					break;
				}
				if (reportedTotal != null && result.reportedTotal() != reportedTotal) {
					addReason(reasons, ReasonCode.TOTAL_CHANGED, "조회 중 VWorld 전체 건수가 " + reportedTotal + "건에서 "
							+ result.reportedTotal() + "건으로 바뀌었습니다.");
				}
			}
			fetchedPages++;
			collected.addAll(result.features());
			int pages = expectedPages(reportedTotal, reportedPages);
			if (page >= pages || result.features().isEmpty()) {
				break;
			}
		}

		if (reportedTotal == null) {
			addReason(reasons, ReasonCode.TOTAL_UNKNOWN, "VWorld가 전체 건수를 알려주지 않아 누락 여부를 확인할 수 없습니다.");
		}
		else if (collected.size() < reportedTotal && reasons.isEmpty()) {
			addReason(reasons, ReasonCode.COUNT_MISMATCH,
					"VWorld 전체 " + reportedTotal + "건 중 " + collected.size() + "건만 수신했습니다.");
		}

		List<MergedBuilding> merged = merge(collected);
		PlanarGeometry.LocalProjection projection = new PlanarGeometry.LocalProjection(lon, lat);
		List<AnalyzedBuilding> included = new ArrayList<>();
		int inside = 0;
		int outside = 0;
		int unavailable = 0;
		for (MergedBuilding building : merged) {
			if (building.polygons.isEmpty()) {
				unavailable++;
				continue;
			}
			PlanarGeometry.Evaluation evaluation = PlanarGeometry.evaluate(building.polygons, projection,
					radiusMeters);
			if (evaluation.relation() == Relation.OUTSIDE) {
				outside++;
				continue;
			}
			if (evaluation.relation() == Relation.INSIDE) {
				inside++;
			}
			included.add(new AnalyzedBuilding(building.id, building.info, evaluation.relation(),
					round(evaluation.distanceMeters(), 100), evaluation.centerInside(), hasHoles(building.polygons),
					roundPolygons(building.polygons)));
		}
		if (unavailable > 0) {
			addReason(reasons, ReasonCode.GEOMETRY_UNAVAILABLE,
					"도형을 읽을 수 없는 건물 " + unavailable + "개는 판정하지 못해 결과에서 제외했습니다.");
		}
		included.sort(Comparator.comparingDouble(AnalyzedBuilding::distanceMeters).thenComparing(AnalyzedBuilding::id));

		Summary summary = new Summary(included.size(), inside, included.size() - inside, outside, unavailable,
				merged.size(), collected.size() - merged.size());
		return new RadiusAnalysisResult(new Center(lon, lat), radiusMeters, RadiusAnalysisResult.CRITERION,
				CRITERION_DESCRIPTION, DISTANCE_DESCRIPTION, reasons.isEmpty(), List.copyOf(reasons.values()),
				reportedTotal, collected.size(), fetchedPages, reportedPages, summary, floorStatistics(included),
				List.copyOf(included), DATA_SOURCE);
	}

	private static int expectedPages(Integer reportedTotal, Integer reportedPages) {
		if (reportedPages != null) {
			return reportedPages;
		}
		if (reportedTotal != null) {
			return (reportedTotal + VWorldBuildingClient.MAX_PAGE_SIZE - 1) / VWorldBuildingClient.MAX_PAGE_SIZE;
		}
		return 1;
	}

	private static void addReason(Map<ReasonCode, IncompleteReason> reasons, ReasonCode code, String message) {
		reasons.putIfAbsent(code, new IncompleteReason(code, message));
	}

	private static final class MergedBuilding {

		final String id;

		final BuildingInfo info;

		final List<double[][][]> polygons = new ArrayList<>();

		MergedBuilding(String id, BuildingInfo info) {
			this.id = id;
			this.info = info;
		}

		void addPolygons(List<double[][][]> more) {
			if (more == null) {
				return;
			}
			for (double[][][] polygon : more) {
				boolean known = this.polygons.stream().anyMatch((existing) -> Arrays.deepEquals(existing, polygon));
				if (!known) {
					this.polygons.add(polygon);
				}
			}
		}

	}

	/**
	 * Merges features of the same building. A real 1 km response contained one bd_mgt_sn on two features with
	 * different footprints, so the footprints are combined instead of dropping one. Features without bd_mgt_sn
	 * are identified by their feature id, and features without both are never merged.
	 */
	private static List<MergedBuilding> merge(List<BuildingFeature> features) {
		Map<String, MergedBuilding> byId = new LinkedHashMap<>();
		for (int i = 0; i < features.size(); i++) {
			BuildingFeature feature = features.get(i);
			String id = identity(feature, i);
			byId.computeIfAbsent(id, (key) -> new MergedBuilding(key, feature.building()))
				.addPolygons(feature.polygons());
		}
		return new ArrayList<>(byId.values());
	}

	static String identity(BuildingFeature feature, int index) {
		String managementNumber = feature.building().buildingManagementNumber();
		if (managementNumber != null) {
			return "bd:" + managementNumber;
		}
		if (feature.featureId() != null) {
			return "feature:" + feature.featureId();
		}
		return "row:" + index;
	}

	private static boolean hasHoles(List<double[][][]> polygons) {
		return polygons.stream().anyMatch((polygon) -> polygon.length > 1);
	}

	static FloorStatistics floorStatistics(List<AnalyzedBuilding> buildings) {
		List<Integer> floors = new ArrayList<>();
		for (AnalyzedBuilding building : buildings) {
			Integer value = validFloors(building.building().groundFloorCount());
			if (value != null) {
				floors.add(value);
			}
		}
		int[] bucketCounts = new int[FLOOR_BUCKETS.length];
		for (int i = 0; i < FLOOR_BUCKETS.length; i++) {
			int min = FLOOR_BUCKETS[i][0];
			int max = FLOOR_BUCKETS[i][1];
			bucketCounts[i] = (int) floors.stream().filter((f) -> f >= min && (max < 0 || f <= max)).count();
		}
		long sum = floors.stream().mapToLong(Integer::longValue).sum();
		Integer min = floors.stream().min(Integer::compare).orElse(null);
		Integer max = floors.stream().max(Integer::compare).orElse(null);
		return floorStatistics(floors.size(), buildings.size() - floors.size(), min, max, sum, bucketCounts);
	}

	/**
	 * Builds the statistics from aggregates, so a saved analysis (aggregated in SQL) is restored with exactly the
	 * same labels and rounding as the live result.
	 *
	 * @param bucketCounts buildings per floor bucket: 1~2, 3~5, 6~10, 11~20, 21+
	 */
	public static FloorStatistics floorStatistics(int withData, int withoutData, Integer min, Integer max,
			long floorSum, int[] bucketCounts) {
		if (bucketCounts.length != FLOOR_BUCKETS.length) {
			throw new IllegalArgumentException("expected " + FLOOR_BUCKETS.length + " floor buckets");
		}
		List<FloorBucket> distribution = new ArrayList<>();
		for (int i = 0; i < FLOOR_BUCKETS.length; i++) {
			int bucketMin = FLOOR_BUCKETS[i][0];
			Integer bucketMax = (FLOOR_BUCKETS[i][1] < 0) ? null : FLOOR_BUCKETS[i][1];
			String label = (bucketMax == null) ? bucketMin + "층 이상" : bucketMin + "~" + bucketMax + "층";
			distribution.add(new FloorBucket(label, bucketMin, bucketMax, bucketCounts[i]));
		}
		if (withData == 0) {
			return new FloorStatistics(0, withoutData, null, null, null, List.copyOf(distribution));
		}
		double average = round((double) floorSum / withData, 10);
		return new FloorStatistics(withData, withoutData, min, max, average, List.copyOf(distribution));
	}

	/** gro_flo_co is a string; only whole numbers of at least 1 are valid ("0" was seen in real responses). */
	public static Integer validFloors(String value) {
		if (value == null || !value.matches("\\d{1,4}")) {
			return null;
		}
		int floors = Integer.parseInt(value);
		return (floors >= 1) ? floors : null;
	}

	private static double round(double value, double scale) {
		return Math.round(value * scale) / scale;
	}

	private static List<double[][][]> roundPolygons(List<double[][][]> polygons) {
		List<double[][][]> rounded = new ArrayList<>(polygons.size());
		for (double[][][] polygon : polygons) {
			double[][][] rings = new double[polygon.length][][];
			for (int r = 0; r < polygon.length; r++) {
				rings[r] = new double[polygon[r].length][];
				for (int p = 0; p < polygon[r].length; p++) {
					rings[r][p] = new double[] { round(polygon[r][p][0], 1e7), round(polygon[r][p][1], 1e7) };
				}
			}
			rounded.add(rings);
		}
		return List.copyOf(rounded);
	}

}
