package com.example.gis_analysis_system.vworld;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.queryParam;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withServerError;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

import org.hamcrest.Matchers;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import tools.jackson.databind.json.JsonMapper;

/**
 * Uses a mocked VWorld server. Both the ERROR shape and the OK shape
 * (result.featureCollection.features[].properties) were confirmed against the real API.
 */
class VWorldBuildingClientTests {

	private static final String SEOUL_CITY_HALL_FEATURE = """
			{"properties": {"bd_mgt_sn": "1114010300100310000000001", "buld_nm": "서울특별시청",
			 "buld_nm_dc": "본관", "gro_flo_co": "13", "sido": "서울특별시", "sigungu": "중구",
			 "gu": null, "rd_nm": "세종대로", "buld_no": "110"}}""";

	private MockRestServiceServer server;

	private VWorldBuildingClient client;

	@BeforeEach
	void setUp() {
		RestClient.Builder builder = RestClient.builder();
		this.server = MockRestServiceServer.bindTo(builder).build();
		this.client = new VWorldBuildingClient(builder, JsonMapper.builder().build(), " test-key ",
				"http://localhost:8080");
	}

	@Test
	void sendsDocumentedParameters() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andExpect(method(HttpMethod.GET))
			.andExpect(queryParam("service", "data"))
			.andExpect(queryParam("request", "GetFeature"))
			.andExpect(queryParam("data", "LT_C_SPBD"))
			.andExpect(queryParam("key", "test-key"))
			.andExpect(queryParam("domain", "http://localhost:8080"))
			.andExpect(queryParam("geomFilter", "POINT(126.978%2037.5665)"))
			.andExpect(queryParam("crs", "EPSG:4326"))
			.andExpect(queryParam("format", "json"))
			.andExpect(queryParam("geometry", "false"))
			.andRespond(withSuccess(notFoundBody(), MediaType.APPLICATION_JSON));

		this.client.findBuildingsAt(126.978, 37.5665);

		this.server.verify();
	}

	@Test
	void singleBuildingIsFound() {
		respond(okBody(1, SEOUL_CITY_HALL_FEATURE));

		BuildingLookupResult result = this.client.findBuildingsAt(126.978, 37.5665);

		assertThat(result.status()).isEqualTo(BuildingLookupResult.Status.FOUND);
		assertThat(result.buildings()).singleElement().satisfies((building) -> {
			assertThat(building.buildingManagementNumber()).isEqualTo("1114010300100310000000001");
			assertThat(building.buildingName()).isEqualTo("서울특별시청");
			assertThat(building.buildingSubName()).isEqualTo("본관");
			assertThat(building.groundFloorCount()).isEqualTo("13");
			assertThat(building.roadName()).isEqualTo("세종대로");
			assertThat(building.buildingNumber()).isEqualTo("110");
			assertThat(building.eupmyeon()).isNull();
		});
	}

	@Test
	void severalBuildingsAreAmbiguous() {
		respond(okBody(2, SEOUL_CITY_HALL_FEATURE + ","
				+ "{\"properties\": {\"bd_mgt_sn\": \"222\", \"buld_nm\": \"다른 건물\"}}"));

		BuildingLookupResult result = this.client.findBuildingsAt(126.978, 37.5665);

		assertThat(result.status()).isEqualTo(BuildingLookupResult.Status.AMBIGUOUS);
		assertThat(result.totalCount()).isEqualTo(2);
		assertThat(result.buildings()).hasSize(2);
	}

	@Test
	void moreResultsThanReturnedAreAmbiguous() {
		respond(okBody(7, SEOUL_CITY_HALL_FEATURE));

		assertThat(this.client.findBuildingsAt(126.978, 37.5665).status())
			.isEqualTo(BuildingLookupResult.Status.AMBIGUOUS);
	}

	@Test
	void duplicateFeaturesOfOneBuildingAreFound() {
		respond(okBody(2, SEOUL_CITY_HALL_FEATURE + "," + SEOUL_CITY_HALL_FEATURE));

		BuildingLookupResult result = this.client.findBuildingsAt(126.978, 37.5665);

		assertThat(result.status()).isEqualTo(BuildingLookupResult.Status.FOUND);
		assertThat(result.buildings()).hasSize(1);
	}

	@Test
	void notFoundStatusMeansNoBuilding() {
		respond(notFoundBody());

		BuildingLookupResult result = this.client.findBuildingsAt(126.978, 37.5665);

		assertThat(result.status()).isEqualTo(BuildingLookupResult.Status.NOT_FOUND);
		assertThat(result.buildings()).isEmpty();
	}

	@Test
	void errorStatusIsReportedWithVWorldCode() {
		// Same shape as the real response to an unregistered key.
		respond("""
				{"response" : {"service" : {"name" : "data", "version" : "2.0", "operation" : "GetFeature", "time" : "1(ms)"},
				 "status" : "ERROR", "error" : {"level" : "2", "code" : "INVALID_KEY", "text" : "등록되지 않은 인증키입니다."}}}""");

		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> this.client.findBuildingsAt(126.978, 37.5665))
			.satisfies((ex) -> {
				assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_ERROR);
				assertThat(ex.getVworldErrorCode()).isEqualTo("INVALID_KEY");
				assertThat(ex.getMessage()).isEqualTo("등록되지 않은 인증키입니다.");
			});
	}

	@Test
	void unknownStructureIsNotGuessed() {
		respond("{\"response\": {\"status\": \"OK\", \"result\": {\"items\": []}}}");

		assertReason(VWorldApiException.Reason.UNEXPECTED_RESPONSE);
	}

	@Test
	void nonJsonBodyIsRejected() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withSuccess("<html>error</html>", MediaType.TEXT_HTML));

		assertReason(VWorldApiException.Reason.UNEXPECTED_RESPONSE);
	}

	@Test
	void httpErrorIsReported() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withServerError());

		assertReason(VWorldApiException.Reason.API_ERROR);
	}

	@Test
	void timeoutIsReported() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withException(new SocketTimeoutException("Read timed out")));

		assertReason(VWorldApiException.Reason.TIMEOUT);
	}

	@Test
	void networkErrorDoesNotExposeTheKey() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withException(new UnknownHostException("api.vworld.kr")));

		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> this.client.findBuildingsAt(126.978, 37.5665))
			.satisfies((ex) -> {
				assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.NETWORK_ERROR);
				assertThat(ex.getMessage()).doesNotContain("test-key");
			});
	}

	@Test
	void missingKeyFailsWithoutCallingVWorld() {
		VWorldBuildingClient withoutKey = new VWorldBuildingClient(RestClient.builder(), JsonMapper.builder().build(),
				"", "http://localhost:8080");

		assertThat(withoutKey.isConfigured()).isFalse();
		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> withoutKey.findBuildingsAt(126.978, 37.5665))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_KEY_MISSING));
	}

	@Test
	void radiusQuerySendsBufferGeometryAndPage() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andExpect(queryParam("data", "LT_C_SPBD"))
			.andExpect(queryParam("key", "test-key"))
			.andExpect(queryParam("domain", "http://localhost:8080"))
			.andExpect(queryParam("geomFilter", "POINT(126.978%2037.5665)"))
			.andExpect(queryParam("buffer", "500"))
			.andExpect(queryParam("geometry", "true"))
			.andExpect(queryParam("size", "1000"))
			.andExpect(queryParam("page", "2"))
			.andExpect(queryParam("crs", "EPSG:4326"))
			.andRespond(withSuccess(notFoundBody(), MediaType.APPLICATION_JSON));

		this.client.findBuildingsWithin(126.978, 37.5665, 500, 2);

		this.server.verify();
	}

	@Test
	void radiusPageIsParsedFromTheRealResponseShape() {
		// Shape of a real geometry=true response: numbers as strings, MultiPolygon footprints, one with a hole.
		respond("""
				{"response": {"service": {"name": "data"}, "status": "OK",
				 "record": {"total": "3420", "current": "1000"},
				 "page": {"total": "4", "current": "1", "size": "1000"},
				 "result": {"featureCollection": {"type": "FeatureCollection", "bbox": [126.96, 37.55, 126.99, 37.57],
				  "features": [
				   {"type": "Feature", "id": "LT_C_SPBD.1110143467",
				    "geometry": {"type": "MultiPolygon", "coordinates": [[
				      [[126.0, 37.0], [126.001, 37.0], [126.001, 37.001], [126.0, 37.001], [126.0, 37.0]],
				      [[126.0004, 37.0004], [126.0004, 37.0006], [126.0006, 37.0006], [126.0004, 37.0004]]]]},
				    "properties": {"bd_mgt_sn": "1111013600101370002013739", "buld_nm": "", "gro_flo_co": "4",
				     "sido": "서울특별시", "sigungu": "종로구", "gu": "인사동", "rd_nm": "인사동길", "buld_no": "9",
				     "buld_nm_dc": "", "bul_eng_nm": ""}},
				   {"type": "Feature", "id": "LT_C_SPBD.2",
				    "geometry": {"type": "Polygon", "coordinates": [[[127.0, 37.0], [127.001, 37.0], [127.001, 37.001]]]},
				    "properties": {"bd_mgt_sn": "2"}}
				  ]}}}}""");

		VWorldBuildingClient.FeaturePage page = this.client.findBuildingsWithin(126.978, 37.5665, 1000, 1);

		assertThat(page.reportedTotal()).isEqualTo(3420);
		assertThat(page.totalPages()).isEqualTo(4);
		assertThat(page.currentPage()).isEqualTo(1);
		assertThat(page.features()).hasSize(2);
		BuildingFeature withHole = page.features().get(0);
		assertThat(withHole.featureId()).isEqualTo("LT_C_SPBD.1110143467");
		assertThat(withHole.building().buildingManagementNumber()).isEqualTo("1111013600101370002013739");
		assertThat(withHole.building().buildingName()).isNull();
		assertThat(withHole.polygons()).singleElement().satisfies((polygon) -> {
			assertThat(polygon).hasNumberOfRows(2);
			assertThat(polygon[0]).hasNumberOfRows(5);
			assertThat(polygon[1][0]).containsExactly(126.0004, 37.0004);
		});
		// A Polygon is accepted too, and an open ring is closed.
		BuildingFeature polygon = page.features().get(1);
		assertThat(polygon.polygons()).singleElement()
			.satisfies((rings) -> assertThat(rings[0][3]).containsExactly(127.0, 37.0));
	}

	@Test
	void unreadableGeometryIsMarkedUnavailable() {
		respond("""
				{"response": {"status": "OK", "record": {"total": "4", "current": "4"},
				 "page": {"total": "1", "current": "1", "size": "1000"},
				 "result": {"featureCollection": {"features": [
				  {"id": "a", "geometry": null, "properties": {"bd_mgt_sn": "1"}},
				  {"id": "b", "geometry": {"type": "Point", "coordinates": [127.0, 37.0]}, "properties": {"bd_mgt_sn": "2"}},
				  {"id": "c", "geometry": {"type": "MultiPolygon", "coordinates": [[[[127.0, "x"], [1, 2], [3, 4], [127.0, "x"]]]]},
				   "properties": {"bd_mgt_sn": "3"}},
				  {"id": "d", "properties": {"bd_mgt_sn": "4"}}
				 ]}}}}""");

		VWorldBuildingClient.FeaturePage page = this.client.findBuildingsWithin(126.978, 37.5665, 100, 1);

		assertThat(page.features()).hasSize(4).allSatisfy((feature) -> {
			assertThat(feature.polygons()).isNull();
			assertThat(feature.hasGeometry()).isFalse();
		});
	}

	@Test
	void radiusNotFoundIsAnEmptyPage() {
		respond("""
				{"response": {"status": "NOT_FOUND", "record": {"total": "0", "current": "0"},
				 "page": {"total": "1", "current": "1", "size": "1000"}}}""");

		VWorldBuildingClient.FeaturePage page = this.client.findBuildingsWithin(125.5, 34.0, 100, 1);

		assertThat(page.reportedTotal()).isZero();
		assertThat(page.features()).isEmpty();
	}

	@Test
	void radiusErrorKeepsTheVWorldCodeWithoutTheKey() {
		// Same shape as the real response to size=1001.
		respond("""
				{"response": {"status": "ERROR", "error": {"level": "1", "code": "INVALID_RANGE",
				 "text": "size 파라미터의 값이 유효한 범위를 넘었습니다."}}}""");

		assertThatExceptionOfType(VWorldApiException.class)
			.isThrownBy(() -> this.client.findBuildingsWithin(126.978, 37.5665, 100, 1))
			.satisfies((ex) -> {
				assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_ERROR);
				assertThat(ex.getVworldErrorCode()).isEqualTo("INVALID_RANGE");
				assertThat(ex.getMessage()).doesNotContain("test-key");
			});
	}

	@Test
	void radiusTimeoutIsReported() {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withException(new SocketTimeoutException("Read timed out")));

		assertThatExceptionOfType(VWorldApiException.class)
			.isThrownBy(() -> this.client.findBuildingsWithin(126.978, 37.5665, 100, 1))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.TIMEOUT));
	}

	@Test
	void radiusQueryNeedsAKey() {
		VWorldBuildingClient withoutKey = new VWorldBuildingClient(RestClient.builder(), JsonMapper.builder().build(),
				" ", "http://localhost:8080");

		assertThatExceptionOfType(VWorldApiException.class)
			.isThrownBy(() -> withoutKey.findBuildingsWithin(126.978, 37.5665, 100, 1))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(VWorldApiException.Reason.API_KEY_MISSING));
	}

	private void respond(String body) {
		this.server.expect(requestTo(Matchers.startsWith(VWorldBuildingClient.DATA_API_URL)))
			.andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
	}

	private void assertReason(VWorldApiException.Reason reason) {
		assertThatExceptionOfType(VWorldApiException.class).isThrownBy(() -> this.client.findBuildingsAt(126.978, 37.5665))
			.satisfies((ex) -> assertThat(ex.getReason()).isEqualTo(reason));
	}

	private static String okBody(int total, String features) {
		return "{\"response\": {\"status\": \"OK\", \"record\": {\"total\": \"" + total + "\", \"current\": \"1\"},"
				+ " \"result\": {\"featureCollection\": {\"type\": \"FeatureCollection\", \"features\": [" + features
				+ "]}}}}";
	}

	private static String notFoundBody() {
		return "{\"response\": {\"status\": \"NOT_FOUND\"}}";
	}

}
