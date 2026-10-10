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
