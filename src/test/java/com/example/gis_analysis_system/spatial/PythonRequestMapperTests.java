package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.example.gis_analysis_system.analysis.RadiusAnalysisResult;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.AnalyzedBuilding;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.IncompleteReason;
import com.example.gis_analysis_system.analysis.RadiusAnalysisResult.ReasonCode;
import com.example.gis_analysis_system.history.AnalysisHistoryService.AnalysisDetail;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;
import com.example.gis_analysis_system.spatial.PythonRequestMapper.AnalysisSource;
import com.example.gis_analysis_system.vworld.BuildingInfo;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The Python request JSON built from real Java results. The Python contract is analysis-service/app/schemas; the
 * reference mapping is analysis-service/tests/java_result.py, ported below ({@link #javaResultToRequest}) so both
 * conversions are compared on the JSON the Java API really produces.
 */
class PythonRequestMapperTests {

	private static final Instant ANALYZED_AT = Instant.parse("2026-10-11T03:00:00.123Z");

	/** RadiusAnalysisRequest + BuildingStatsRequest fields (Python rejects any other field). */
	private static final Set<String> BUILDING_STATS_FIELDS = Set.of("schemaVersion", "source", "center",
			"radiusMeters", "complete", "incompleteReasons", "javaSummary", "includeBuildings", "buildings");

	private static final Set<String> BUILDING_FIELDS = Set.of("id", "groundFloorRaw", "relation", "distanceMeters",
			"geometry");

	private final JsonMapper jsonMapper = JsonMapper.builder().build();

	private final PythonRequestMapper mapper = new PythonRequestMapper(this.jsonMapper);

	@Test
	void buildingStatsOfALiveResult() {
		RadiusAnalysisResult result = SpatialFixtures.liveResult();
		JsonNode json = read(this.mapper.buildingStats(result, new AnalysisSource(null, ANALYZED_AT), false));

		assertThat(names(json)).isEqualTo(BUILDING_STATS_FIELDS);
		assertThat(json.get("schemaVersion").asInt()).isEqualTo(1);
		assertThat(json.get("source").get("kind").asString()).isEqualTo("LIVE");
		assertThat(json.get("source").get("analysisId").isNull()).isTrue();
		assertThat(json.get("source").get("analyzedAt").asString()).isEqualTo("2026-10-11T03:00:00.123Z");
		assertThat(json.get("center").get("lon").asDouble()).isEqualTo(result.center().lon());
		assertThat(json.get("center").get("lat").asDouble()).isEqualTo(result.center().lat());
		assertThat(json.get("radiusMeters").asInt()).isEqualTo(100);
		assertThat(json.get("complete").asBoolean()).isFalse();
		assertThat(json.get("incompleteReasons").get(0).get("code").asString()).isEqualTo("PAGE_LIMIT");
		assertThat(names(json.get("incompleteReasons").get(0))).containsExactlyInAnyOrder("code", "message");
		assertThat(json.get("javaSummary").get("intersecting").asInt()).isEqualTo(result.summary().intersecting());
		assertThat(names(json.get("javaSummary"))).containsExactlyInAnyOrder("intersecting", "inside", "partial",
				"outsideExcluded", "geometryUnavailable", "distinctBuildings", "mergedDuplicateFeatures");
		assertThat(json.get("includeBuildings").asBoolean()).isFalse();

		JsonNode buildings = json.get("buildings");
		assertThat(buildings).hasSize(result.buildings().size());
		List<String> ids = new ArrayList<>();
		for (int i = 0; i < buildings.size(); i++) {
			JsonNode building = buildings.get(i);
			AnalyzedBuilding source = result.buildings().get(i);
			assertThat(names(building)).isEqualTo(BUILDING_FIELDS);
			assertThat(building.get("id").asString()).isEqualTo(source.id());
			assertThat(building.get("relation").asString()).isEqualTo(source.relation().name());
			assertThat(building.get("distanceMeters").asDouble()).isEqualTo(source.distanceMeters());
			assertThat(building.get("geometry").get("type").asString()).isEqualTo("MultiPolygon");
			assertThat(this.jsonMapper.treeToValue(building.get("geometry").get("coordinates"), double[][][][].class))
				.isDeepEqualTo(source.polygons().toArray(new double[0][][][]));
			ids.add(source.id());
		}
		// bd:, feature: and row: identifiers, "0" and missing floor values are all sent as they are.
		assertThat(ids).anyMatch((id) -> id.startsWith("bd:"))
			.anyMatch((id) -> id.startsWith("feature:"))
			.anyMatch((id) -> id.startsWith("row:"));
		assertThat(groundFloors(buildings)).contains("13", "0", "25").containsNull();
		// The building with a hole keeps both rings and its second part.
		JsonNode withHole = buildings.get(0).get("geometry").get("coordinates");
		assertThat(withHole).hasSize(2);
		assertThat(withHole.get(0)).hasSize(2);
	}

	@Test
	void savedSourceAndGridOptions() {
		RadiusAnalysisResult result = SpatialFixtures.liveResult();
		JsonNode json = read(this.mapper.gridDensity(result, new AnalysisSource(12L, ANALYZED_AT), 50, false, true));

		assertThat(names(json)).isEqualTo(Set.of("schemaVersion", "source", "center", "radiusMeters", "complete",
				"incompleteReasons", "javaSummary", "buildings", "cellSizeMeters", "includeEmptyCells",
				"includeCellBuildingIds"));
		assertThat(json.get("source").get("kind").asString()).isEqualTo("SAVED");
		assertThat(json.get("source").get("analysisId").asLong()).isEqualTo(12);
		assertThat(json.get("cellSizeMeters").asInt()).isEqualTo(50);
		assertThat(json.get("includeEmptyCells").asBoolean()).isFalse();
		assertThat(json.get("includeCellBuildingIds").asBoolean()).isTrue();
	}

	@Test
	void compareSendsCriterionAndDataSource() {
		RadiusAnalysisResult before = SpatialFixtures.syntheticResult(3, 0);
		RadiusAnalysisResult after = SpatialFixtures.syntheticResult(3, 1);
		JsonNode json = read(this.mapper.compare(before, new AnalysisSource(12L, Instant.parse("2026-03-01T00:00:00Z")),
				after, new AnalysisSource(15L, ANALYZED_AT), false, true));

		assertThat(names(json)).containsExactlyInAnyOrder("schemaVersion", "before", "after", "includeUnchanged",
				"includeBuildingChanges");
		JsonNode side = json.get("before");
		assertThat(names(side)).containsExactlyInAnyOrder("schemaVersion", "source", "center", "radiusMeters",
				"complete", "incompleteReasons", "javaSummary", "buildings", "criterion", "dataSource");
		assertThat(side.get("source").get("analyzedAt").asString()).isEqualTo("2026-03-01T00:00:00Z");
		assertThat(json.get("after").get("source").get("analysisId").asLong()).isEqualTo(15);
		assertThat(side.get("criterion").asString()).isEqualTo("POLYGON_INTERSECTS_CIRCLE");
		assertThat(names(side.get("dataSource"))).containsExactlyInAnyOrder("provider", "layer", "coordinateSystem",
				"notice");
		assertThat(side.get("dataSource").get("layer").asString()).isEqualTo(before.source().layer());
		assertThat(json.get("includeUnchanged").asBoolean()).isFalse();
		assertThat(json.get("includeBuildingChanges").asBoolean()).isTrue();
	}

	@Test
	void compareNeedsSavedAnalyses() {
		RadiusAnalysisResult result = SpatialFixtures.syntheticResult(1, 0);

		assertThatIllegalArgumentException().isThrownBy(() -> this.mapper.compare(result,
				new AnalysisSource(null, ANALYZED_AT), result, new AnalysisSource(2L, ANALYZED_AT), false, true));
	}

	@Test
	void valuesPythonWouldRejectAreShortenedOrStopped() {
		RadiusAnalysisResult base = SpatialFixtures.syntheticResult(1, 0);
		AnalyzedBuilding building = base.buildings().get(0);
		String longFloors = "1".repeat(25);
		RadiusAnalysisResult shortened = withBuildings(base,
				List.of(withFloors(building, longFloors), withFloors(building, "가".repeat(30))),
				List.of(new IncompleteReason(ReasonCode.PAGE_LIMIT, "가".repeat(400))));
		JsonNode json = read(this.mapper.buildingStats(shortened, new AnalysisSource(null, ANALYZED_AT), false));

		assertThat(json.get("buildings").get(0).get("groundFloorRaw").asString()).isEqualTo("1".repeat(20));
		assertThat(json.get("buildings").get(1).get("groundFloorRaw").asString()).isEqualTo("가".repeat(20));
		assertThat(json.get("incompleteReasons").get(0).get("message").asString()).isEqualTo("가".repeat(300));

		RadiusAnalysisResult longId = withBuildings(base, List.of(new AnalyzedBuilding("feature:" + "x".repeat(80),
				building.building(), building.relation(), 1, false, false, building.polygons())), List.of());
		assertThatExceptionOfType(AnalysisServiceException.class)
			.isThrownBy(() -> this.mapper.buildingStats(longId, new AnalysisSource(null, ANALYZED_AT), false))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(Reason.ANALYSIS_DATA_UNSUPPORTED));
	}

	@Test
	void shortenCountsCodePoints() {
		assertThat(PythonRequestMapper.shorten("😀😀😀", 2)).isEqualTo("😀😀");
		assertThat(PythonRequestMapper.shorten("abc", 3)).isEqualTo("abc");
		assertThat(PythonRequestMapper.shorten(null, 3)).isNull();
	}

	// ----------------------------------------------------------------- tests/java_result.py

	@Test
	void savedAnalysisMatchesJavaResultPy() {
		AnalysisDetail detail = new AnalysisDetail(12, "서울시청", ANALYZED_AT, ANALYZED_AT.plusSeconds(5),
				SpatialFixtures.liveResult());
		JsonNode javaJson = this.jsonMapper.valueToTree(detail);

		ObjectNode expected = javaResultToRequest(javaJson);
		ObjectNode actual = (ObjectNode) read(this.mapper.buildingStats(detail.result(),
				new AnalysisSource(detail.analysisId(), detail.analyzedAt()), true));
		actual.remove("schemaVersion");  // java_result.py relies on the Python defaults (1, includeBuildings true)
		actual.remove("includeBuildings");

		assertThat(actual).isEqualTo(normalized(expected));
	}

	@Test
	void liveResultMatchesJavaResultPy() {
		RadiusAnalysisResult result = SpatialFixtures.liveResult();
		// GET /api/buildings/nearby: the result fields at the top level, plus analysisToken and analyzedAt.
		ObjectNode nearby = this.jsonMapper.valueToTree(result);
		nearby.put("analysisToken", "0f8fad5b-d9cb-469f-a165-70867728950e");
		nearby.put("analyzedAt", ANALYZED_AT.toString());

		ObjectNode actual = (ObjectNode) read(
				this.mapper.buildingStats(result, new AnalysisSource(null, ANALYZED_AT), true));
		actual.remove("schemaVersion");
		actual.remove("includeBuildings");

		assertThat(actual).isEqualTo(normalized(javaResultToRequest(nearby)));
	}

	@Test
	void compareMatchesJavaResultPy() {
		AnalysisDetail before = SpatialFixtures.detail(12, "2026-03-01T00:00:00Z", SpatialFixtures.syntheticResult(4, 0));
		AnalysisDetail after = SpatialFixtures.detail(15, "2026-09-01T00:00:00.5Z", SpatialFixtures.liveResult());

		ObjectNode actual = (ObjectNode) read(this.mapper.compare(before.result(),
				new AnalysisSource(12L, before.analyzedAt()), after.result(), new AnalysisSource(15L, after.analyzedAt()),
				false, true));
		for (String side : new String[] { "before", "after" }) {
			((ObjectNode) actual.get(side)).remove("schemaVersion");
		}
		ObjectNode expected = this.jsonMapper.createObjectNode();
		expected.set("before", savedAnalysis(this.jsonMapper.valueToTree(before)));
		expected.set("after", savedAnalysis(this.jsonMapper.valueToTree(after)));
		actual.remove("schemaVersion");
		actual.remove("includeUnchanged");
		actual.remove("includeBuildingChanges");

		assertThat(actual).isEqualTo(normalized(expected));
	}

	/** Port of to_request() in analysis-service/tests/java_result.py. */
	private ObjectNode javaResultToRequest(JsonNode java) {
		JsonNode detail = java.has("result") ? java.get("result") : java;
		ObjectNode source = this.jsonMapper.createObjectNode();
		if (java.has("analysisId")) {
			source.put("kind", "SAVED");
			source.set("analysisId", java.get("analysisId"));
		}
		else {
			source.put("kind", "LIVE");
			source.putNull("analysisId");  // Python default
		}
		source.set("analyzedAt", java.get("analyzedAt"));
		ObjectNode request = this.jsonMapper.createObjectNode();
		request.set("source", source);
		request.set("center", detail.get("center"));
		request.set("radiusMeters", detail.get("radiusMeters"));
		request.set("complete", detail.get("complete"));
		ArrayNode reasons = request.putArray("incompleteReasons");
		for (JsonNode reason : detail.get("incompleteReasons")) {
			reasons.addObject().put("code", reason.get("code").asString()).put("message", reason.get("message").asString());
		}
		request.set("javaSummary", detail.get("summary"));
		ArrayNode buildings = request.putArray("buildings");
		for (JsonNode b : detail.get("buildings")) {
			ObjectNode building = buildings.addObject();
			building.set("id", b.get("id"));
			building.set("groundFloorRaw", b.get("building").get("groundFloorCount"));
			building.set("relation", b.get("relation"));
			building.set("distanceMeters", b.get("distanceMeters"));
			ObjectNode geometry = building.putObject("geometry");
			geometry.put("type", "MultiPolygon");
			geometry.set("coordinates", b.get("polygons"));
		}
		return request;
	}

	/** Port of _saved_analysis() in analysis-service/tests/java_result.py. */
	private ObjectNode savedAnalysis(JsonNode detail) {
		ObjectNode request = javaResultToRequest(detail);
		JsonNode result = detail.get("result");
		JsonNode source = result.get("source");
		request.set("criterion", result.get("criterion"));
		ObjectNode dataSource = request.putObject("dataSource");
		for (String field : new String[] { "provider", "layer", "coordinateSystem", "notice" }) {
			dataSource.set(field, source.get(field));
		}
		return request;
	}

	// ----------------------------------------------------------------- helpers

	/** Through JSON text, so numbers have the node types of a parsed body (12 is an IntNode, not a LongNode). */
	private JsonNode normalized(JsonNode node) {
		return read(this.jsonMapper.writeValueAsBytes(node));
	}

	private JsonNode read(byte[] json) {
		return this.jsonMapper.readTree(json);
	}

	private static Set<String> names(JsonNode node) {
		return Set.copyOf(node.propertyNames());
	}

	private static List<String> groundFloors(JsonNode buildings) {
		List<String> floors = new ArrayList<>();
		buildings.forEach((b) -> floors.add(b.get("groundFloorRaw").isNull() ? null : b.get("groundFloorRaw").asString()));
		return floors;
	}

	private static AnalyzedBuilding withFloors(AnalyzedBuilding building, String floors) {
		BuildingInfo info = building.building();
		return new AnalyzedBuilding(building.id() + floors.length() + floors.charAt(0),
				new BuildingInfo(info.buildingManagementNumber(), info.buildingName(), info.buildingSubName(), floors,
						info.sido(), info.sigungu(), info.eupmyeon(), info.roadName(), info.buildingNumber()),
				building.relation(), building.distanceMeters(), building.centerInside(), building.hasHoles(),
				building.polygons());
	}

	private static RadiusAnalysisResult withBuildings(RadiusAnalysisResult r, List<AnalyzedBuilding> buildings,
			List<IncompleteReason> reasons) {
		return new RadiusAnalysisResult(r.center(), r.radiusMeters(), r.criterion(), r.criterionDescription(),
				r.distanceDescription(), reasons.isEmpty(), reasons, r.reportedTotal(), r.fetchedFeatures(),
				r.fetchedPages(), r.reportedPages(), r.summary(), r.floorStatistics(), buildings, r.source());
	}

}
