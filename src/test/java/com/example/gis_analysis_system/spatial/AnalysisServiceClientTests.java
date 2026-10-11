package com.example.gis_analysis_system.spatial;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.springframework.test.web.client.ExpectedCount.never;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.util.unit.DataSize;
import org.springframework.web.client.RestClient;

import com.example.gis_analysis_system.spatial.AnalysisServiceClient.Endpoint;
import com.example.gis_analysis_system.spatial.AnalysisServiceException.Reason;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The client against a mocked Python service: request shape, response checks and error translation. */
@ExtendWith(OutputCaptureExtension.class)
class AnalysisServiceClientTests {

	private static final String BASE = "http://127.0.0.1:8001";

	private static final byte[] BODY = "{\"x\":1}".getBytes(StandardCharsets.UTF_8);

	private static final String PYTHON_SECRET_MESSAGE = "Traceback in /srv/app.py: secret detail";

	private final MutableClock clock = new MutableClock();

	private MockRestServiceServer server;

	private AnalysisServiceClient client(AnalysisServiceProperties properties) {
		RestClient.Builder builder = RestClient.builder();
		this.server = MockRestServiceServer.bindTo(builder).build();
		return new AnalysisServiceClient(properties, JsonMapper.builder().build(), builder, builder, builder,
				this.clock);
	}

	private AnalysisServiceClient client() {
		return client(AnalysisServiceProperties.of(BASE, SpatialFixtures.TOKEN));
	}

	// ----------------------------------------------------------------- requests

	@Test
	void sendsTheBodyWithTokenAndJsonContentType() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andExpect(method(HttpMethod.POST))
			.andExpect(header(AnalysisServiceClient.TOKEN_HEADER, SpatialFixtures.TOKEN))
			.andExpect(content().contentType(MediaType.APPLICATION_JSON))
			.andExpect(content().bytes(BODY))
			.andRespond(withSuccess(SpatialFixtures.buildingStatsResponse(), MediaType.APPLICATION_JSON));

		JsonNode result = client.post(Endpoint.BUILDING_STATS, BODY);

		assertThat(result.get("counts").get("analyzed").asInt()).isEqualTo(1);
		this.server.verify();
	}

	@Test
	void eachEndpointHasItsPath() {
		AnalysisServiceClient client = client(AnalysisServiceProperties.of(BASE + "/", SpatialFixtures.TOKEN));
		this.server.expect(requestTo(BASE + "/internal/v1/grid-density"))
			.andRespond(withSuccess(SpatialFixtures.gridDensityResponse(), MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(BASE + "/internal/v1/compare-analyses"))
			.andRespond(withSuccess(SpatialFixtures.compareResponse(true), MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(BASE + "/internal/v1/compare-analyses"))
			.andRespond(withSuccess(SpatialFixtures.compareResponse(false), MediaType.APPLICATION_JSON));

		assertThat(client.post(Endpoint.GRID_DENSITY, BODY).get("cells").get("features")).hasSize(1);
		assertThat(client.post(Endpoint.COMPARE, BODY).get("comparable").asBoolean()).isTrue();
		assertThat(client.post(Endpoint.COMPARE, BODY).get("comparable").asBoolean()).isFalse();
		this.server.verify();
	}

	// ----------------------------------------------------------------- configuration

	@Test
	void withoutTokenNothingIsSent() {
		AnalysisServiceClient client = client(AnalysisServiceProperties.of(BASE, "  "));
		this.server.expect(never(), requestTo(BASE + "/internal/v1/building-stats"));

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_NOT_CONFIGURED);
		assertThat(client.isConfigured()).isFalse();
		assertThat(client.isAvailable()).isFalse();
		this.server.verify();
	}

	@ParameterizedTest
	@ValueSource(strings = { "http://10.0.0.5:8001", "http://example.com:8001", "https://api.example.com",
			"ftp://127.0.0.1:8001", "http://user@127.0.0.1:8001", "http://127.0.0.1:8001@evil.example",
			"http://127.0.0.1:8001/prefix", "http://127.0.0.1:8001/?x=1", "127.0.0.1:8001", "", "http://0x7f.0.0.1",
			"http://127.0.0.1.evil.example" })
	void tokenIsNeverSentToANonLoopbackOrUnusualUrl(String url) {
		AnalysisServiceClient client = client(AnalysisServiceProperties.of(url, SpatialFixtures.TOKEN));

		assertThat(AnalysisServiceProperties.urlProblem(url)).isNotNull();
		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_NOT_CONFIGURED);
		assertThat(client.isAvailable()).isFalse();
		this.server.verify();  // no request at all: any request would have failed the mock server
	}

	@ParameterizedTest
	@ValueSource(strings = { "http://127.0.0.1:8001", "http://127.0.0.1:8001/", "https://127.0.0.1", "http://localhost:8001",
			"http://LOCALHOST:8001", "http://[::1]:8001", "http://127.1.2.3:9000" })
	void loopbackUrlsAreAccepted(String url) {
		assertThat(AnalysisServiceProperties.urlProblem(url)).isNull();
	}

	@Test
	void propertiesHideTheToken() {
		AnalysisServiceProperties properties = AnalysisServiceProperties.of(BASE, SpatialFixtures.TOKEN);

		assertThat(properties.toString()).doesNotContain(SpatialFixtures.TOKEN).contains("internalToken=(set)");
		assertThat(properties.connectTimeout()).isEqualTo(Duration.ofSeconds(1));
		assertThat(properties.readTimeout()).isEqualTo(Duration.ofSeconds(15));
		assertThat(properties.compareReadTimeout()).isEqualTo(Duration.ofSeconds(30));
		assertThat(properties.statusTimeout()).isLessThan(properties.readTimeout());
		assertThat(properties.maxConcurrentRequests()).isEqualTo(2);
		assertThat(properties.unavailableCooldown()).isEqualTo(Duration.ofSeconds(10));
		assertThat(properties.maxRequestBytes()).isEqualTo(DataSize.ofMegabytes(16));
		assertThat(properties.compareMaxRequestBytes()).isEqualTo(DataSize.ofMegabytes(32));
	}

	// ----------------------------------------------------------------- Python errors

	@Test
	void unauthorizedIsAuthFailed() {
		AnalysisServiceClient client = client();
		respondError(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED");

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_AUTH_FAILED);
	}

	@Test
	void payloadTooLargeIsTooLarge() {
		AnalysisServiceClient client = client();
		respondError(HttpStatus.CONTENT_TOO_LARGE, "PAYLOAD_TOO_LARGE");

		assertReason(() -> client.post(Endpoint.COMPARE, BODY), Reason.ANALYSIS_TOO_LARGE);
	}

	@Test
	void validationErrorKeepsOnlyPythonsCode() {
		AnalysisServiceClient client = client();
		respondError(HttpStatus.UNPROCESSABLE_CONTENT, "DUPLICATE_BUILDING_ID");

		AnalysisServiceException ex = assertReason(() -> client.post(Endpoint.GRID_DENSITY, BODY),
				Reason.ANALYSIS_DATA_UNSUPPORTED);
		assertThat(ex.getServiceError()).isEqualTo("DUPLICATE_BUILDING_ID");
		assertThat(ex.getMessage()).doesNotContain(PYTHON_SECRET_MESSAGE);
	}

	@Test
	void serviceUnavailableIsUnavailable() {
		AnalysisServiceClient client = client();
		respondError(HttpStatus.SERVICE_UNAVAILABLE, "INTERNAL_TOKEN_NOT_CONFIGURED");

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
	}

	@ParameterizedTest
	@ValueSource(ints = { 500, 400, 404, 415, 502 })
	void otherStatusesAreServiceErrors(int status) {
		AnalysisServiceClient client = client();
		respondError(HttpStatus.valueOf(status), "INTERNAL_ERROR");

		AnalysisServiceException ex = assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY),
				Reason.ANALYSIS_SERVICE_ERROR);
		assertThat(ex.getMessage()).doesNotContain(PYTHON_SECRET_MESSAGE).doesNotContain("Traceback");
		assertThat(ex.getServiceError()).isNull();
	}

	@Test
	void errorBodiesThatAreNotJsonAreStillTranslated() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withStatus(HttpStatus.UNPROCESSABLE_CONTENT).body("<html>no</html>"));

		AnalysisServiceException ex = assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY),
				Reason.ANALYSIS_DATA_UNSUPPORTED);
		assertThat(ex.getServiceError()).isNull();
	}

	// ----------------------------------------------------------------- invalid responses

	@ParameterizedTest
	@ValueSource(strings = { "not json", "", "[]", "null", "{\"schemaVersion\": 2}", "{\"schemaVersion\": \"1\"}",
			"{\"counts\": {}}" })
	void bodiesThatAreNotTheContractAreBadResponses(String body) {
		AnalysisServiceClient client = client();
		respondOk(body);

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_BAD_RESPONSE);
	}

	@ParameterizedTest
	@ValueSource(strings = { "\"radiusMeters\": 100,|\"radiusMeters\": \"100\",",
			"\"analyzed\": 1,|\"analyzed\": 1.5,", "\"complete\": true,|\"complete\": \"true\",",
			"\"scope\": \"COMPLETE_RESULT\"|\"scope\": \"ALL\"", "\"warnings\": [],|\"warnings\": {},",
			"\"withinRadius\": {\"unionArea\": 200.0,|\"withinRadius\": {\"unionArea\": null,",
			"\"buildings\": null|\"buildings\": {}" })
	void buildingStatsFieldTypesAreChecked(String replacement) {
		String[] parts = replacement.split("\\|");
		String body = SpatialFixtures.buildingStatsResponse().replace(parts[0], parts[1]);
		assertThat(body).isNotEqualTo(SpatialFixtures.buildingStatsResponse());
		AnalysisServiceClient client = client();
		respondOk(body);

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_BAD_RESPONSE);
	}

	@ParameterizedTest
	@ValueSource(strings = { "\"type\": \"FeatureCollection\"|\"type\": \"Feature\"",
			"\"returnedCellCount\": 1|\"returnedCellCount\": 2", "\"type\": \"Polygon\"|\"type\": \"Point\"",
			"\"buildingCount\": 1,|\"buildingCount\": \"1\",", "\"cellSizeMeters\": 100,|" })
	void gridDensityStructureIsChecked(String replacement) {
		String[] parts = replacement.split("\\|", -1);
		String body = SpatialFixtures.gridDensityResponse().replace(parts[0], parts[1]);
		assertThat(body).isNotEqualTo(SpatialFixtures.gridDensityResponse());
		AnalysisServiceClient client = client();
		respondOk(body);

		assertReason(() -> client.post(Endpoint.GRID_DENSITY, BODY), Reason.ANALYSIS_SERVICE_BAD_RESPONSE);
	}

	@Test
	void compareStructureIsChecked() {
		String comparableWithoutStatistics = SpatialFixtures.compareResponse(false).replace("\"comparable\": false",
				"\"comparable\": true");
		String notComparableWithStatistics = SpatialFixtures.compareResponse(true).replace("\"comparable\": true",
				"\"comparable\": false");
		String unknownBasis = SpatialFixtures.compareResponse(true).replace("\"CHANGE\"", "\"GUESS\"");
		for (String body : new String[] { comparableWithoutStatistics, notComparableWithStatistics, unknownBasis }) {
			AnalysisServiceClient client = client();
			respondOk(body);
			assertReason(() -> client.post(Endpoint.COMPARE, BODY), Reason.ANALYSIS_SERVICE_BAD_RESPONSE);
		}
	}

	@Test
	void responsesOverTheLimitAreBadResponses() {
		AnalysisServiceClient client = client(new AnalysisServiceProperties(BASE, SpatialFixtures.TOKEN, null, null,
				null, null, 0, null, null, null, DataSize.ofBytes(100)));
		respondOk(SpatialFixtures.buildingStatsResponse());

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_BAD_RESPONSE);
	}

	// ----------------------------------------------------------------- network failures and cooldown

	@Test
	void connectionRefusedStartsTheCooldown() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withException(new ConnectException("Connection refused")));

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		this.server.verify();

		// Within 10 s nothing is sent (an unexpected request would fail the mock server).
		this.clock.advance(Duration.ofSeconds(9));
		assertReason(() -> client.post(Endpoint.GRID_DENSITY, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		assertReason(client::requireAvailable, Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		this.server.verify();

		this.server.reset();
		this.clock.advance(Duration.ofSeconds(1));
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withSuccess(SpatialFixtures.buildingStatsResponse(), MediaType.APPLICATION_JSON));
		assertThat(client.post(Endpoint.BUILDING_STATS, BODY).get("schemaVersion").asInt()).isEqualTo(1);
		this.server.verify();
	}

	@Test
	void connectTimeoutIsUnavailable() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/compare-analyses"))
			.andRespond(withException(new SocketTimeoutException("Connect timed out")));

		assertReason(() -> client.post(Endpoint.COMPARE, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
		assertReason(client::requireAvailable, Reason.ANALYSIS_SERVICE_UNAVAILABLE);
	}

	@Test
	void responseTimeoutIsTimeoutWithoutCooldown() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withException(new SocketTimeoutException("Read timed out")));
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withSuccess(SpatialFixtures.buildingStatsResponse(), MediaType.APPLICATION_JSON));

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_TIMEOUT);
		client.requireAvailable();
		assertThat(client.post(Endpoint.BUILDING_STATS, BODY)).isNotNull();
		this.server.verify();
	}

	@Test
	void otherIoFailuresAreUnavailable() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withException(new IOException("Connection reset")));

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, BODY), Reason.ANALYSIS_SERVICE_UNAVAILABLE);
	}

	@Test
	void timeoutClassification() {
		assertThat(AnalysisServiceClient.isResponseTimeout(new SocketTimeoutException("Read timed out"))).isTrue();
		assertThat(AnalysisServiceClient.isResponseTimeout(new SocketTimeoutException(null))).isTrue();
		assertThat(AnalysisServiceClient.isResponseTimeout(new SocketTimeoutException("Connect timed out"))).isFalse();
		assertThat(AnalysisServiceClient.isResponseTimeout(new java.net.http.HttpConnectTimeoutException("x")))
			.isFalse();
		assertThat(AnalysisServiceClient.isResponseTimeout(new java.net.http.HttpTimeoutException("x"))).isTrue();
		assertThat(AnalysisServiceClient.isResponseTimeout(new ConnectException())).isFalse();
	}

	// ----------------------------------------------------------------- request size

	@Test
	void requestsOver16MibAreRejectedBeforeSending() {
		AnalysisServiceClient client = client();
		this.server.expect(never(), requestTo(BASE + "/internal/v1/building-stats"));
		byte[] body = new byte[16 * 1024 * 1024 + 1];

		assertReason(() -> client.post(Endpoint.BUILDING_STATS, body), Reason.ANALYSIS_TOO_LARGE);
		assertReason(() -> client.post(Endpoint.GRID_DENSITY, body), Reason.ANALYSIS_TOO_LARGE);
		this.server.verify();
	}

	@Test
	void compareAcceptsUpTo32Mib() {
		AnalysisServiceClient client = client();
		byte[] large = new byte[16 * 1024 * 1024 + 1];
		this.server.expect(requestTo(BASE + "/internal/v1/compare-analyses"))
			.andRespond(withSuccess(SpatialFixtures.compareResponse(true), MediaType.APPLICATION_JSON));

		assertThat(client.post(Endpoint.COMPARE, large)).isNotNull();
		assertReason(() -> client.post(Endpoint.COMPARE, new byte[32 * 1024 * 1024 + 1]), Reason.ANALYSIS_TOO_LARGE);
		this.server.verify();
	}

	// ----------------------------------------------------------------- status

	@Test
	void statusUsesHealth() {
		AnalysisServiceClient client = client();
		this.server.expect(requestTo(BASE + "/health"))
			.andExpect(method(HttpMethod.GET))
			.andRespond(withSuccess("{\"status\":\"ok\"}", MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(BASE + "/health")).andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));
		this.server.expect(requestTo(BASE + "/health"))
			.andRespond(withSuccess("{\"status\":\"starting\"}", MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(BASE + "/health")).andRespond(withSuccess("oops", MediaType.TEXT_PLAIN));
		this.server.expect(requestTo(BASE + "/health")).andRespond(withException(new ConnectException()));

		assertThat(client.isAvailable()).isTrue();
		for (int i = 0; i < 4; i++) {
			assertThat(client.isAvailable()).isFalse();
		}
		this.server.verify();
	}

	// ----------------------------------------------------------------- logs

	@Test
	void tokenAndBodiesNeverReachTheLog(CapturedOutput output) {
		AnalysisServiceClient client = client();
		byte[] geometry = "{\"coordinates\":[[126.9781234,37.5661234]]}".getBytes(StandardCharsets.UTF_8);
		respondError(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED");
		respondError(HttpStatus.UNPROCESSABLE_CONTENT, "VALIDATION_ERROR");
		respondError(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR");
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withSuccess(SpatialFixtures.buildingStatsResponse(), MediaType.APPLICATION_JSON));
		this.server.expect(requestTo(BASE + "/internal/v1/building-stats"))
			.andRespond(withException(new ConnectException()));

		for (int i = 0; i < 5; i++) {
			try {
				client.post(Endpoint.BUILDING_STATS, geometry);
			}
			catch (AnalysisServiceException ex) {
				assertThat(ex.getMessage()).doesNotContain(SpatialFixtures.TOKEN);
			}
		}

		assertThat(output.getAll()).contains("rejected the internal token")
			.doesNotContain(SpatialFixtures.TOKEN)
			.doesNotContain("126.9781234")
			.doesNotContain(PYTHON_SECRET_MESSAGE);
	}

	// ----------------------------------------------------------------- helpers

	private void respondOk(String body) {
		this.server.expect(requestTo(org.hamcrest.Matchers.startsWith(BASE)))
			.andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
	}

	private void respondError(HttpStatus status, String error) {
		this.server.expect(requestTo(org.hamcrest.Matchers.startsWith(BASE)))
			.andRespond(withStatus(status).contentType(MediaType.APPLICATION_JSON)
				.body("{\"error\":\"" + error + "\",\"message\":\"" + PYTHON_SECRET_MESSAGE + "\"}"));
	}

	private static AnalysisServiceException assertReason(Runnable call, Reason reason) {
		AnalysisServiceException[] caught = new AnalysisServiceException[1];
		assertThatExceptionOfType(AnalysisServiceException.class).isThrownBy(call::run).satisfies((ex) -> {
			assertThat(ex.getReason()).isEqualTo(reason);
			caught[0] = ex;
		});
		return caught[0];
	}

	static final class MutableClock extends Clock {

		private Instant now = Instant.parse("2026-10-11T03:00:00Z");

		void advance(Duration duration) {
			this.now = this.now.plus(duration);
		}

		@Override
		public ZoneOffset getZone() {
			return ZoneOffset.UTC;
		}

		@Override
		public Clock withZone(java.time.ZoneId zone) {
			return this;
		}

		@Override
		public Instant instant() {
			return this.now;
		}

	}

}
